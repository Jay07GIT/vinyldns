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

import cats.implicits._
import org.slf4j.LoggerFactory
import scalikejdbc._
import vinyldns.core.domain.record._
import vinyldns.core.protobuf.ProtobufConversions
import vinyldns.core.route.Monitored
import cats.effect.IO
import vinyldns.core.domain.record.NameSort.{ASC, NameSort}
import vinyldns.core.domain.record.RecordType.RecordType
import vinyldns.mysql.repository.MySqlRecordSetRepository.{PagingKey, fromRecordType, toFQDN}
import vinyldns.proto.VinylDNSProto

import java.util.regex.{Matcher, Pattern}

class MySqlRecordSetDataRepository
    extends RecordSetDataRepository
    with Monitored
    with ProtobufConversions {

  private val INSERT_RECORDSETDATA =
    sql"INSERT IGNORE INTO recordset_data(recordset_id, zone_id, zone_name, fqdn,  reverse_fqdn, type, record_data, ip, owner_group_id, data) VALUES ({recordset_id}, {zone_id}, {zone_name}, {fqdn}, {reverse_fqdn}, {type}, {record_data}, {ip}, {owner_group_id}, {data})"

  private val DELETE_RECORDSETDATA =
    sql"DELETE FROM recordset_data WHERE recordset_id = ?"

  private val DELETE_RECORDSETDATA_IN_ZONE =
    sql"DELETE FROM recordset_data WHERE zone_id = ?"

  private val COUNT_RECORDSETDATA_IN_ZONE =
    sql"""
         |SELECT count(*)
         |  FROM recordset_data
         | WHERE zone_id = {zone_id}
    """.stripMargin

  private val BASE_FIND_RECORDSETS_BY_FQDNS =
    """
      |SELECT data, fqdn
      |  FROM recordset_data
      | WHERE fqdn
    """.stripMargin

  private val FIND_BY_ZONEID_NAME_TYPE =
    sql"""
         |SELECT data, fqdn
         |  FROM recordset_data
         | WHERE zone_id = {zone_id} AND zone_name = {zone_name} AND type = {type}
    """.stripMargin

  private val FIND_BY_ZONEID_NAME =
    sql"""
         |SELECT data, fqdn
         |  FROM recordset_data
         | WHERE zone_id = {zone_id} AND zone_name = {zone_name}
    """.stripMargin


  private val FIND_BY_ID =
    sql"""
         |SELECT  data, fqdn
         |  FROM recordset_data
         | WHERE recordset_id = {recordset_id}
    """.stripMargin

  private val FIND_BY_IP =
    sql"""
         |SELECT data, fqdn
         |  FROM recordset_data
         | WHERE ip = {ip}
    """.stripMargin

  private val GET_RECORDSETDATA_BY_OWNERID =
    sql"""
         |SELECT recordset_id
         |  FROM recordset_data
         |WHERE owner_group_id = {ownerGroupId}
         |LIMIT 1
    """.stripMargin

  private final val logger = LoggerFactory.getLogger(classOf[MySqlRecordSetRepository])

  def save(db: DB, changeSet: ChangeSet): IO[ChangeSet] = {
    val byStatus = changeSet.changes.groupBy(_.status)
    val failedChanges = byStatus.getOrElse(RecordSetChangeStatus.Failed, Seq())
    val (failedCreates, failedUpdatesOrDeletes) =
      failedChanges.partition(_.changeType == RecordSetChangeType.Create)

    val reversionDeletes = failedCreates.map(d => Seq[Any](d.recordSet.id))
    failedUpdatesOrDeletes.flatMap { change =>
      change.updates.map { oldRs =>
        Seq[Any](
          RsData(
            db,
            oldRs.id,
            oldRs.zoneId,
            oldRs.name,
            toFQDN(change.zone.name, oldRs.name),
            toFQDN(change.zone.name, oldRs.name).reverse,
            oldRs.typ.toString,
            oldRs.records.toString,
            oldRs.ownerGroupId,
            "update",
            toPB(oldRs).toByteArray,
          )
        )
      }
    }
    // address successful and pending changes
    val completeChanges = byStatus.getOrElse(RecordSetChangeStatus.Complete, Seq())
    val completeChangesByType = completeChanges.groupBy(_.changeType)
    val completeCreates = completeChangesByType.getOrElse(RecordSetChangeType.Create, Seq())
    val completeUpdates = completeChangesByType.getOrElse(RecordSetChangeType.Update, Seq())
    val completeDeletes = completeChangesByType.getOrElse(RecordSetChangeType.Delete, Seq())

    val pendingChanges = byStatus.getOrElse(RecordSetChangeStatus.Pending, Seq())

    // all pending changes are saved as if they are creates
    (completeCreates ++ pendingChanges).map { i =>
      Seq[Any](
        RsData(
          db,
          i.recordSet.id,
          i.recordSet.records.toString,
          i.recordSet.typ.toString,
          i.recordSet.zoneId,
          i.recordSet.name,
          toFQDN(i.zone.name, i.recordSet.name),
          toFQDN(i.zone.name, i.recordSet.name).reverse,
          i.recordSet.ownerGroupId,
          "insert",
          toPB(i.recordSet).toByteArray,
        ))
    }
    completeUpdates.map { u =>
      Seq[Any](
        RsData(
          db,
          u.recordSet.id,
          u.recordSet.records.toString,
          u.recordSet.typ.toString,
          u.recordSet.zoneId,
          u.recordSet.name,
          toFQDN(u.zone.name, u.recordSet.name),
          toFQDN(u.zone.name, u.recordSet.name).reverse,
          u.recordSet.ownerGroupId,
          "update",
          toPB(u.recordSet).toByteArray,
        )
      )
    }
    val deletes: Seq[Seq[Any]] = completeDeletes.map(d => Seq[Any](d.recordSet.id))
    IO {
      db.withinTx { implicit session =>
        (deletes ++ reversionDeletes).grouped(1000).foreach { group =>
          DELETE_RECORDSETDATA.batch(group: _*).apply()
        }
      }
    }.as(changeSet)

  }

  def deleteRecordSetDataInZone(db: DB, zone_id: String, zoneName: String): IO[Unit] =
    monitor("repo.RecordSet.deleteRecordSetDataInZone") {
      IO {
        val numDeleted = db.withinTx { implicit session =>
          DELETE_RECORDSETDATA_IN_ZONE
            .bind(zone_id)
            .update()
            .apply()
        }
        logger.info(s"Deleted $numDeleted records from zone $zoneName (zone id: $zone_id)")
      }.handleErrorWith { error =>
        logger.error(s"Failed deleting records from zone $zoneName (zone id: $zone_id)", error)
        IO.raiseError(error)
      }
    }

  def RsData(
              db: DB,
              recordID: String,
              recordData: String,
              recordType: String,
              zoneId: String,
              zoneName: String,
              FQDN: String,
              reverseFQDN: String,
              ownerGroupId: Option[String],
              rs: String,
              data: Array[Byte]
            ): Unit =
    rs match {
      /**
       * insert the rsdata first, as if recordset are created
       */
      case "insert" => rsDataSave(db, recordID, recordData, recordType, zoneId, zoneName, FQDN, reverseFQDN, ownerGroupId, data)
      case "update" =>
        db.withinTx { implicit session =>
          DELETE_RECORDSETDATA
            .bind(recordID)
            .update()
            .apply()
        }
        rsDataSave(db, recordID, recordData, recordType, zoneId, zoneName, FQDN, reverseFQDN, ownerGroupId, data)
    }

  def rsDataSave(
                  db: DB,
                  recordId: String,
                  recordData: String,
                  recordType: String,
                  zoneId: String,
                  zoneName: String,
                  FQDN: String,
                  reverseFQDN: String,
                  ownerGroupId: Option[String],
                  data: Array[Byte]
                ): Unit = {
    recordType match {
      case "DS" => for (ipString<- recordData.split(Pattern.quote("),")).map(_.trim).toList) {
        insertRecordSetData(db, recordId, zoneId, zoneName, FQDN, reverseFQDN, recordType, ipString, ownerGroupId, data)}
      case _ => for (ipString <- recordData.split(",").map(_.trim).toList) {
        insertRecordSetData(db,recordId,zoneId,zoneName,FQDN,reverseFQDN,recordType,ipString,ownerGroupId,data)}
    }}

  def insertRecordSetData(
              db: DB,
              recordId: String,
              zoneId: String,
              zoneName: String,
              FQDN: String,
              reverseFQDN: String,
              recordType: String,
              ipString: String,
              ownerGroupId: Option[String],
              data: Array[Byte]
            ): Unit = {
    var parseIp: String = null
    var records: String = null
    parseIp = parseIP(ipString, recordType)
    records = ipString.replace("List(", "")
    records = records.replace(")", "")
    records = extractRecordSetDataString(records, recordType)

  /**
   * insert the rsdata first, as if recordset are created/updated
   */

  db.withinTx { implicit session =>
    INSERT_RECORDSETDATA
      .bindByName(
        'recordset_id -> recordId,
        'zone_id -> zoneId,
        'zone_name -> zoneName,
        'fqdn -> FQDN,
        'reverse_fqdn -> reverseFQDN,
        'type -> recordType,
        'record_data -> records,
        'ip -> parseIp,
        'owner_group_id -> ownerGroupId,
        'data -> data
      )
      .update()
      .apply()
  }}

  def getRecordSetDataList(zoneId: String, zoneName: String, typ: RecordType): IO[List[RecordSet]] =
    monitor("repo.RecordSet.getRecordSetDataList") {
      IO {
        DB.readOnly { implicit s =>
          FIND_BY_ZONEID_NAME_TYPE
            .bindByName(
              'zone_id -> zoneId,
              'zone_name -> zoneName,
              'type -> typ.toString )
            .map(toRecordSetData)
            .list()
            .apply()
        }
      }
    }

  // Note: In MySql we do not need the zone id, since can hit the key directly
  def getRecordSetData(recordSetId: String): IO[Option[RecordSet]] =
    monitor("repo.RecordSet.getRecordSetData") {
      IO {
        DB.readOnly { implicit s =>
          FIND_BY_ID.bindByName('recordset_id -> recordSetId).map(toRecordSetData).single().apply()
        }
      }
    }

  def getRecordSetDataByIP(recordSetIP: String): IO[Option[RecordSet]] =
    monitor("repo.RecordSet.getRecordSetData") {
      IO {
        DB.readOnly { implicit s =>
          FIND_BY_IP.bindByName('ip -> recordSetIP).map(toRecordSetData).single().apply()
        }
      }
    }

  def getRecordSetDataByName(zoneId: String, zoneName: String): IO[List[RecordSet]] =
    monitor("repo.RecordSet.getRecordSetDataByName") {
      IO {
        DB.readOnly { implicit s =>
          FIND_BY_ZONEID_NAME
            .bindByName('zone_id -> zoneId, 'zone_name -> zoneName)
            .map(toRecordSetData)
            .list()
            .apply()
        }
      }
    }

  def getRecordSetDataListByFQDNs(names: Set[String]): IO[List[RecordSet]] =
    monitor("repo.RecordSet.getRecordSetDataListByFQDNs") {
      IO {
        if (names.isEmpty)
          List[RecordSet]()
        else {
          DB.readOnly { implicit s =>
            val namesList = names.toList
            val inClause = " IN (" + namesList.as("?").mkString(",") + ")"
            val query = BASE_FIND_RECORDSETS_BY_FQDNS + inClause
            SQL(query)
              .bind(namesList: _*)
              .map(toRecordSetData)
              .list()
              .apply()
          }
        }
      }
    }

  def getRecordSetDataCount(zoneId: String): IO[Int] =
    monitor("repo.RecordSet.getRecordSetDataCount") {
      IO {
        DB.readOnly { implicit s =>
          // this is a count query, so should always return a value.  However, scalikejdbc doesn't have this,
          // so we have to default to 0.  it is literally impossible to not return a value
          COUNT_RECORDSETDATA_IN_ZONE
            .bindByName('zone_id -> zoneId)
            .map(_.int(1))
            .single
            .apply()
            .getOrElse(0)
        }
      }
    }

  def getFirstOwnedRecordSetDataByGroup(ownerGroupId: String): IO[Option[String]] =
    monitor("repo.RecordSet.getFirstOwnedRecordSetDataByGroup") {
      IO {
        DB.readOnly { implicit s =>
          GET_RECORDSETDATA_BY_OWNERID
            .bindByName('ownerGroupId -> ownerGroupId)
            .map(_.string(1))
            .single
            .apply()
        }
      }
    }

  def listRecordSetData(
                      zoneId: Option[String],
                      startFrom: Option[String],
                      maxItems: Option[Int],
                      recordNameFilter: Option[String],
                      recordTypeFilter: Option[Set[RecordType]],
                      recordOwnerGroupFilter: Option[String],
                      nameSort: NameSort
                    ): IO[ListRecordSetDataResults] =
    monitor("repo.RecordSet.listRecordSetData") {
      IO {
        DB.readOnly { implicit s =>
          val maxPlusOne = maxItems.map(_ + 1)

          // setup optional filters
          val zoneAndNameFilters = (zoneId, recordNameFilter) match {
            case (Some(zId), Some(rName)) =>
              Some(sqls"zone_id = $zId AND zone_name LIKE ${rName.replace('*', '%')} ")
            //case (None, Some(fqdn)) => Some(sqls"fqdn LIKE ${fqdn.replace('*', '%')} ")
            case (None, Some(fqdn)) =>  val reversefqdn = fqdn.reverse // reverse the fqdn.
              Some(sqls"reverse_fqdn LIKE ${reversefqdn.replace('*', '%')} ")
            case (Some(zId), None) => Some(sqls"zone_id = $zId ")
            case _ => None
          }

          val searchByZone = zoneId.fold[Boolean](false)(_ => true)
          val pagingKey = PagingKey(startFrom)

          // sort by name or fqdn in given order
          val sortBy = (searchByZone, nameSort) match {
            case (true, NameSort.DESC) =>
              pagingKey.as(
                sqls"((zone_name <= ${pagingKey.map(pk => pk.recordName)} AND type > ${pagingKey.map(pk => pk.recordType)}) OR zone_name < ${pagingKey.map(pk => pk.recordName)})"
              )
            case (false, NameSort.ASC) =>
              pagingKey.as(
                sqls"((fqdn >= ${pagingKey.map(pk => pk.recordName)} AND type > ${pagingKey.map(pk => pk.recordType)}) OR fqdn > ${pagingKey.map(pk => pk.recordName)})"
              )
            case (false, NameSort.DESC) =>
              pagingKey.as(
                sqls"((fqdn <= ${pagingKey.map(pk => pk.recordName)} AND type > ${pagingKey.map(pk => pk.recordType)}) OR fqdn < ${pagingKey.map(pk => pk.recordName)})"
              )
            case _ =>
              pagingKey.as(
                sqls"((zone_name >= ${pagingKey.map(pk => pk.recordName)} AND type > ${pagingKey.map(pk => pk.recordType)}) OR zone_name > ${pagingKey.map(pk => pk.recordName)})"
              )
          }

          val typeFilter = recordTypeFilter.map { t =>
            val list = t.map(fromRecordType)
            sqls"type IN ($list)"
          }

          val ownerGroupFilter =
            recordOwnerGroupFilter.map(owner => sqls"owner_group_id = $owner ")

          val opts =
            (zoneAndNameFilters ++ sortBy ++ typeFilter ++ ownerGroupFilter).toList

          val qualifiers = if (nameSort == ASC) {
            sqls"ORDER BY fqdn ASC, type ASC "
          }
          else {
            sqls"ORDER BY fqdn DESC, type ASC "
          }

          val recordLimit = maxPlusOne match {
            case Some(limit) => sqls"LIMIT $limit"
            case None => sqls""
          }

          val finalQualifiers = qualifiers.append(recordLimit)

          // construct query
          val initialQuery = sqls"SELECT data, fqdn FROM recordset_data "

          val appendOpts = if (opts.nonEmpty){
            val setDelimiter = SQLSyntax.join(opts, sqls"AND")
            val addWhere = sqls"WHERE"
            addWhere.append(setDelimiter)
          } else sqls""

          val appendQueries = initialQuery.append(appendOpts)

          val finalQuery = appendQueries.append(finalQualifiers)

          val results = sql"$finalQuery"
            .map(toRecordSetData)
            .list()
            .apply()

          val newResults = if (maxPlusOne.contains(results.size)) {
            results.dropRight(1)
          } else {
            results
          }

          println(zoneAndNameFilters)
          println(searchByZone)
          println(pagingKey)
          println(sortBy)
          println(typeFilter)
          println(ownerGroupFilter)
          println(opts)
          println(qualifiers)
          println(recordLimit)
          println(finalQualifiers)
          println(initialQuery)
          println(appendOpts)
          println(appendQueries)
          println(finalQuery)
          println(results)
          println(newResults)

          // if size of results is less than the maxItems plus one, we don't have a next id
          // if maxItems is None, we don't have a next id

          val nextId = maxPlusOne
            .filter(_ == results.size)
            .flatMap(_ => newResults.lastOption.map(PagingKey.toNextId(_, searchByZone)))

          ListRecordSetDataResults(
            recordSets = newResults,
            nextId = nextId,
            startFrom = startFrom,
            maxItems = maxItems,
            recordNameFilter = recordNameFilter,
            recordTypeFilter = recordTypeFilter,
            nameSort = nameSort
          )
        }
      }
    }

  def parseIP(
               ipString: String,
               recordType: String
             ): String = {
    var ipAddress: String = null
    val IPADDRESS_IPV4_PATTERN = {
      "\\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\\b"
    }
    val IPADDRESS_IPV6_PATTERN = {
      "(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))"
    }

    /**
     *  parse ip address from the recordset data
     */
    val patternipv4: Pattern = Pattern.compile(IPADDRESS_IPV4_PATTERN)
    val patternipv6: Pattern = Pattern.compile(IPADDRESS_IPV6_PATTERN)
    val matcheripv4: Matcher = patternipv4.matcher(ipString)
    val matcheripv6: Matcher = patternipv6.matcher(ipString)

    if (matcheripv4.find() && (recordType == "A" || recordType == "AAAA" || recordType == "PTR")) {
      ipAddress = matcheripv4.group().mkString
    } else if (matcheripv6
      .find() && (recordType == "A" || recordType == "AAAA" || recordType == "PTR")) {
      ipAddress = matcheripv6.group().mkString
    } else ipAddress = null
    ipAddress
  }

  def extractRecordSetDataString(
               recordSetData: String,
               recordType: String
             ): String = {
    var records : String = null
    recordType match {

      /**
       * Append the textual representation of the record data.
       */

      case "A"|"AAAA" =>   records = "address:\"".concat(recordSetData+"\"")
      case "CNAME" =>  records = "cname:\"".concat(recordSetData+"\"")
      case "SOA" => val rs=recordSetData.split(" ")
        records=
          "mname:\"".concat(rs(0)+"\"").
            concat("  rname:\""+rs(1)+"\"").
            concat("  serial:"+rs(2)).
            concat("  refresh:"+rs(3)).
            concat("  retry:"+rs(4)).
            concat("  expire:"+rs(5)).
            concat("  minimum:"+rs(6))
      case "DS" => val rs=recordSetData.split(" ")
        rs(5)=rs(5).replace("))","")
        records=
          "keyTag:".concat(rs(0)).
            concat("  algorithm:"+rs(1)).
            concat("  digestType:"+rs(2)).
            concat("  digest:\""+rs(5)+"\"")
      case "MX" => val rs=recordSetData.split(" ")
        records=
          "preference:".concat(rs(0)).
            concat("  exchange:\""+rs(1)+"\"")
      case "NS" =>  records= "nsdname:\"".concat(recordSetData+"\"")
      case "PTR" => records= "ptrdname:\"".concat(recordSetData+"\"")
      case "SPF" => records= "text:\"".concat(recordSetData+"\"")
      case "SRV" => val rs=recordSetData.split(" ")
        records=
          "priority:".concat(rs(0)).
            concat("  weight:"+rs(1)).
            concat("  port:"+rs(2)).
            concat("  target:\""+rs(3)+"\"")
      case "NAPTR" => val rs=recordSetData.split(" ")
        records=
          "order:".concat(rs(0)).
            concat("  preference:"+rs(1)).
            concat("  flags:\""+rs(2)+"\"").
            concat("  service:\""+rs(3)+"\"").
            concat("  regexp:\""+rs(4)+"\"").
            concat("  replacement:\""+rs(5)+"\"")
      case "SSHFP" =>
        val rs=recordSetData.split(" ")
        records=
          "algorithm:".concat(rs(0)).
            concat("  typ:"+rs(1)).
            concat("  fingerPrint:\""+rs(2)+"\"")
      case "TXT" => records= "text:\"".concat(recordSetData+"\"")
      case "UNKNOWN" => records= "UnknownRecordType:\"".concat(recordSetData+"\"")
      case _ => records= "null"
  }
    records
  }

  def toRecordSetData(rs: WrappedResultSet): RecordSet =
    fromPB(VinylDNSProto.RecordSet.parseFrom(rs.bytes(1))).copy(fqdn = rs.stringOpt(2))
}