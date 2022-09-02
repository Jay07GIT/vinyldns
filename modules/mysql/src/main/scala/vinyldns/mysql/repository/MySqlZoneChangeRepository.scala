/*
 * Copyright 2018 Comcast Cable Communications Management, LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

package vinyldns.mysql.repository

import cats.effect.IO
import org.joda.time.DateTime
import org.slf4j.LoggerFactory
import scalikejdbc._
import vinyldns.core.domain.auth.AuthPrincipal
import vinyldns.core.domain.membership.User
import vinyldns.core.domain.zone._
import vinyldns.core.protobuf._
import vinyldns.core.route.Monitored
import vinyldns.proto.VinylDNSProto

class MySqlZoneChangeRepository
    extends ZoneChangeRepository
    with ProtobufConversions
    with Monitored {
  private final val logger = LoggerFactory.getLogger(classOf[MySqlZoneChangeRepository])
  private final val MAX_ACCESSORS = 30

  private final val PUT_ZONE_CHANGE =
    sql"""
      |REPLACE INTO zone_change (change_id, zone_id, data, created_timestamp)
      |  VALUES ({change_id}, {zone_id}, {data}, {created_timestamp})
      """.stripMargin

  private final val BASE_ZONE_CHANGE_SEARCH_SQL =
    """
      |SELECT zc.data
      |  FROM zone_change zc
       """.stripMargin

  private final val LIST_ZONES_CHANGES =
    sql"""
      |SELECT zc.data
      |  FROM zone_change zc
      |  WHERE zc.zone_id = {zoneId} AND zc.created_timestamp <= {startFrom}
      |  ORDER BY zc.created_timestamp DESC
      |  LIMIT {maxItems}
    """.stripMargin

  override def save(zoneChange: ZoneChange): IO[ZoneChange] =
    monitor("repo.ZoneChange.save") {
      IO {
        logger.debug(s"Saving zone change ${zoneChange.id}")
        DB.localTx { implicit s =>
          PUT_ZONE_CHANGE
            .bindByName(
              'change_id -> zoneChange.id,
              'zone_id -> zoneChange.zoneId,
              'data -> toPB(zoneChange).toByteArray,
              'created_timestamp -> zoneChange.created.getMillis
            )
            .update()
            .apply()

          zoneChange
        }
      }
    }

  override def listZoneChanges(
      zoneId: String,
      startFrom: Option[String],
      maxItems: Int
  ): IO[ListZoneChangesResults] =
    // sorted from most recent, startFrom is an offset from the most recent change
    monitor("repo.ZoneChange.listZoneChanges") {
      IO {
        logger.debug(s"Getting zone changes for zone $zoneId")
        DB.readOnly { implicit s =>
          val startValue = startFrom.getOrElse(DateTime.now().getMillis.toString)
          // maxItems gets a plus one to know if the table is exhausted so we can conditionally give a nextId
          val queryResult = LIST_ZONES_CHANGES
            .bindByName(
              'zoneId -> zoneId,
              'startFrom -> startValue,
              'maxItems -> (maxItems + 1)
            )
            .map(extractZoneChange(1))
            .list()
            .apply()
          val maxQueries = queryResult.take(maxItems)

          // nextId is Option[String] to maintains backwards compatibility
          // earlier maxItems was incremented, if the (maxItems + 1) size is not reached then pages are exhausted
          val nextId = queryResult match {
            case _ if queryResult.size <= maxItems | queryResult.isEmpty => None
            case _ => Some(queryResult.last.created.getMillis.toString)
          }

          ListZoneChangesResults(maxQueries, nextId, startFrom, maxItems)
        }
      }
    }

  private def withAccessors(
                             user: User,
                             groupIds: Seq[String],
                             ignoreAccessZones: Boolean
                           ): (String, Seq[Any]) =
  // Super users do not need to join across to check zone access as they have access to all of the zones
    if (ignoreAccessZones || user.isSuper || user.isSupport) {
      (BASE_ZONE_CHANGE_SEARCH_SQL, Seq.empty)
    } else {
      // User is not super or support,
      // let's join across to the zone access table so we return only zones a user has access to
      val accessors = buildZoneSearchAccessorList(user, groupIds)
      val questionMarks = List.fill(accessors.size)("?").mkString(",")
      val withAccessorCheck = BASE_ZONE_CHANGE_SEARCH_SQL +
        s"""
           |    JOIN zone_access za ON zc.zone_id = za.zone_id
           |      AND za.accessor_id IN ($questionMarks)
    """.stripMargin
      (withAccessorCheck, accessors)
    }

  /* Limit the accessors so that we don't have boundless parameterized queries */
  private def buildZoneSearchAccessorList(user: User, groupIds: Seq[String]): Seq[String] = {
    val allAccessors = user.id +: groupIds

    if (allAccessors.length > MAX_ACCESSORS) {
      logger.warn(
        s"User ${user.userName} with id ${user.id} is in more than $MAX_ACCESSORS groups, no all zones maybe returned!"
      )
    }

    // Take the top 30 accessors, but add "EVERYONE" to the list so that we include zones that have everyone access
    allAccessors.take(MAX_ACCESSORS) :+ "EVERYONE"
  }

  def listDeletedZones(
                 authPrincipal: AuthPrincipal,
                 zoneNameFilter: Option[String] = None,
                 startFrom: Option[String] = None,
                 maxItems: Int = 100,
                 ignoreAccess: Boolean = false
               ): IO[ListDeletedZonesChangeResults] =
    monitor("repo.ZoneChange.listDeletedZoneInZoneChanges") {
      IO {
        DB.readOnly { implicit s =>
          val (withAccessorCheck, accessors) =
            withAccessors(authPrincipal.signedInUser, authPrincipal.memberGroupIds, ignoreAccess)
          val sb = new StringBuilder
          sb.append(withAccessorCheck)

          val query = sb.toString

          val zoneChangeResults: List[ZoneChange] =
            SQL(query)
            .bind(accessors: _*)
            .map(extractZoneChange(1))
            .list()
            .apply()

          // get only deleted zones data.
          val deletedZoneResults: List[ZoneChange] =
            zoneChangeResults.filter(_.zone.status.equals(ZoneStatus.Deleted)).distinct

          val results: List[ZoneChange]=
          if(zoneNameFilter.nonEmpty){
            deletedZoneResults.filter(r=>r.zone.name.contains(zoneNameFilter.getOrElse("not found")))
          }else {
            deletedZoneResults
          }.take(maxItems+1)

          val (newResults, nextId) =
            if (results.size > maxItems)
              (results.dropRight(1), results.dropRight(1).lastOption.map(_.zone.name))
            else (results, None)

          ListDeletedZonesChangeResults(
            zoneDeleted = newResults,
            nextId = nextId,
            startFrom = startFrom,
            maxItems = maxItems,
            zoneChangeFilter = zoneNameFilter,
            ignoreAccess = ignoreAccess
          )
        }
      }
    }

  private def extractZoneChange(colIndex: Int): WrappedResultSet => ZoneChange = res => {
    fromPB(VinylDNSProto.ZoneChange.parseFrom(res.bytes(colIndex)))
  }
}
