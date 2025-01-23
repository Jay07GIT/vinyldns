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

package vinyldns.api.domain.zone

import cats.effect.IO
import cats.implicits._
import vinyldns.api.domain.access.AccessValidationsAlgebra
import vinyldns.api.Interfaces
import vinyldns.core.domain.auth.AuthPrincipal
import vinyldns.api.repository.ApiDataAccessor
import vinyldns.core.crypto.CryptoAlgebra
import vinyldns.core.domain.membership.{Group, GroupRepository, ListUsersResults, User, UserRepository}
import vinyldns.core.domain.zone._
import vinyldns.core.queue.MessageQueue
import vinyldns.core.domain.DomainHelpers.ensureTrailingDot
import vinyldns.core.domain.backend.BackendResolver
import com.cronutils.model.definition.CronDefinition
import com.cronutils.model.definition.CronDefinitionBuilder
import com.cronutils.parser.CronParser
import com.cronutils.model.CronType
import org.xbill.DNS.{DClass, Message, NSRecord, Name, Rcode, Record, SOARecord, SimpleResolver, TSIG, Type, Update}
import scalaj.http.{Http, HttpOptions}
import vinyldns.api.domain.membership.MembershipService

import java.io.{File, IOException, PrintWriter}
import java.nio.charset.StandardCharsets
import java.nio.file.{Files, Paths, StandardOpenOption}
import scala.util.Try

object ZoneService {
  def apply(
      dataAccessor: ApiDataAccessor,
      connectionValidator: ZoneConnectionValidatorAlgebra,
      messageQueue: MessageQueue,
      zoneValidations: ZoneValidations,
      accessValidation: AccessValidationsAlgebra,
      backendResolver: BackendResolver,
      crypto: CryptoAlgebra,
      membershipService:MembershipService
  ): ZoneService =
    new ZoneService(
      dataAccessor.zoneRepository,
      dataAccessor.groupRepository,
      dataAccessor.userRepository,
      dataAccessor.zoneChangeRepository,
      connectionValidator,
      messageQueue,
      zoneValidations,
      accessValidation,
      backendResolver,
      crypto,
      membershipService
    )
}

class ZoneService(
    zoneRepository: ZoneRepository,
    groupRepository: GroupRepository,
    userRepository: UserRepository,
    zoneChangeRepository: ZoneChangeRepository,
    connectionValidator: ZoneConnectionValidatorAlgebra,
    messageQueue: MessageQueue,
    zoneValidations: ZoneValidations,
    accessValidation: AccessValidationsAlgebra,
    backendResolver: BackendResolver,
    crypto: CryptoAlgebra,
    membershipService:MembershipService
) extends ZoneServiceAlgebra {

  import accessValidation._
  import zoneValidations._
  import Interfaces._

  def connectToZone(
      createZoneInput: CreateZoneInput,
      auth: AuthPrincipal
  ): Result[ZoneCommandResult] =
    for {
      _ <- isValidZoneAcl(createZoneInput.acl).toResult
      _ <- membershipService.emailValidation(createZoneInput.email)
      _ <- connectionValidator.isValidBackendId(createZoneInput.backendId).toResult
      _ <- validateSharedZoneAuthorized(createZoneInput.shared, auth.signedInUser).toResult
      _ <- zoneDoesNotExist(createZoneInput.name)
      _ <- adminGroupExists(createZoneInput.adminGroupId)
      _ <- if(createZoneInput.recurrenceSchedule.isDefined) canScheduleZoneSync(auth).toResult else IO.unit.toResult
      isCronStringValid = if(createZoneInput.recurrenceSchedule.isDefined) isValidCronString(createZoneInput.recurrenceSchedule.get) else true
      _ <- validateCronString(isCronStringValid).toResult
      _ <- canChangeZone(auth, createZoneInput.name, createZoneInput.adminGroupId).toResult
      createdZoneInput = if(createZoneInput.recurrenceSchedule.isDefined) createZoneInput.copy(scheduleRequestor = Some(auth.signedInUser.userName)) else createZoneInput
      zoneToCreate = Zone(createdZoneInput, auth.isTestUser)
      _ <- connectionValidator.validateZoneConnections(zoneToCreate)
      createZoneChange <- ZoneChangeGenerator.forAdd(zoneToCreate, auth).toResult
      _ <- messageQueue.send(createZoneChange).toResult[Unit]
    } yield createZoneChange

  def updateZone(updateZoneInput: UpdateZoneInput, auth: AuthPrincipal): Result[ZoneCommandResult] =
    for {
      _ <- isValidZoneAcl(updateZoneInput.acl).toResult
      _ <- membershipService.emailValidation(updateZoneInput.email)
      _ <- connectionValidator.isValidBackendId(updateZoneInput.backendId).toResult
      existingZone <- getZoneOrFail(updateZoneInput.id)
      _ <- validateSharedZoneAuthorized(
        existingZone.shared,
        updateZoneInput.shared,
        auth.signedInUser
      ).toResult
      _ <- canChangeZone(auth, existingZone.name, existingZone.adminGroupId).toResult
      _ <- if(updateZoneInput.recurrenceSchedule.isDefined) canScheduleZoneSync(auth).toResult else IO.unit.toResult
      isCronStringValid = if(updateZoneInput.recurrenceSchedule.isDefined) isValidCronString(updateZoneInput.recurrenceSchedule.get) else true
      _ <- validateCronString(isCronStringValid).toResult
      _ <- adminGroupExists(updateZoneInput.adminGroupId)
      // if admin group changes, this confirms user has access to new group
      _ <- canChangeZone(auth, updateZoneInput.name, updateZoneInput.adminGroupId).toResult
      updatedZoneInput = if(updateZoneInput.recurrenceSchedule.isDefined) updateZoneInput.copy(scheduleRequestor = Some(auth.signedInUser.userName)) else updateZoneInput
      zoneWithUpdates = Zone(updatedZoneInput, existingZone)
      _ <- validateZoneConnectionIfChanged(zoneWithUpdates, existingZone)
      updateZoneChange <- ZoneChangeGenerator
        .forUpdate(zoneWithUpdates, existingZone, auth, crypto)
        .toResult
      _ <- messageQueue.send(updateZoneChange).toResult[Unit]
    } yield updateZoneChange

  def deleteZone(zoneId: String, auth: AuthPrincipal): Result[ZoneCommandResult] =
    for {
      zone <- getZoneOrFail(zoneId)
      _ <- canChangeZone(auth, zone.name, zone.adminGroupId).toResult
      deleteZoneChange <- ZoneChangeGenerator.forDelete(zone, auth).toResult
      _ <- messageQueue.send(deleteZoneChange).toResult[Unit]
    } yield deleteZoneChange

  def createzone(
                  createZoneInput: CreateZoneInput,
                  auth: AuthPrincipal
                ): Result[ZoneCommandResult] =
    for {

//      _ <- createDirectoryWithPermissions(new File("/etc/bind/zones")).toResult
//      _ <- createDirectoryWithPermissions(new File("/etc/bind")).toResult
      //_ <- testTSIGConnection().toResult
      //_ <- toCreateZoneMessage(createZoneInput.name).toResult
      _ <- setupNewZoneInContainer("babe40bc2708", createZoneInput.name,"admin.test.com.").toResult
      //_ <- createZoneUsingRestApi(createZoneInput.name,"admin.test.com.").toResult
     // _ <- createZone(createZoneInput.name,"admin.test.com.").toResult
      zoneToCreate = Zone(createZoneInput, auth.isTestUser)
      createZoneChange <- ZoneChangeGenerator.forAdd(zoneToCreate, auth).toResult
    } yield createZoneChange


  private val defaultTTL = 3600
  val resolverHost: String = "127.0.0.1"
  val resolverPort: Int = 19001
  val tsigKeyName: String = "vinyldns."
  val tsigSecret: String = "nzisn+4G2ldMn0q1CV3vsg=="
  val zoneFilePath = "/etc/bind/zones/example.com.db"



  def createZoneUsingRestApi(zoneName: String, adminEmail: String): Either[String, String] = {
    try {
      val bindApiUrl = "http://127.0.0.1:19001/api/v1"
      val zoneConfig = s"""{
        "name": "${zoneName}",
        "type": "master",
        "file": "/var/named/${zoneName}.zone",
        "allow-update": { "key": "${tsigKeyName}" }
      }"""
      println("weqreqerwqrewq")


      // Create zone file content first
      val zoneContent = s"""$$TTL 3600
                           |@       IN      SOA     ns1.${zoneName}. ${adminEmail.replace('@', '.')}. (
                           |                        ${System.currentTimeMillis() / 1000} ; serial
                           |                        3600        ; refresh
                           |                        600         ; retry
                           |                        86400       ; expire
                           |                        3600 )      ; minimum
                           |
                           |        IN      NS      ns1.${zoneName}.
                           |        IN      NS      ns2.${zoneName}.
                           |""".stripMargin

      // Write zone file
      val writer = new PrintWriter(new File(s"/var/bind/default/${zoneName}zone"))
      println("writer",writer)
      writer.write(zoneContent)
      writer.close()
      println("close")

      // Make REST API call
      val response = Http(s"$bindApiUrl/zones")
        .postData(zoneConfig)
        .header("content-type", "application/json")
        .option(HttpOptions.followRedirects(true))
        .asString

      if (response.code == 201) {
        Right(s"Zone ${zoneName} created successfully")
      } else {
        Left(s"Failed to create zone: ${response.body}")
      }
    } catch {
      case e: Exception =>
        println(e.getMessage)
        Left(s"Failed to create zone: ${e.getMessage}")
    }
  }


  def createZone(zoneName: String, adminEmail: String): Either[String, String] = {
    println(s"Creating zone: $zoneName")

    try {
      val resolver = new SimpleResolver(resolverHost)
      resolver.setPort(resolverPort)
      resolver.setTCP(true)

      val tsigKey = new TSIG(
        TSIG.HMAC_MD5,
        Name.fromString(tsigKeyName),
        tsigSecret
      )
      resolver.setTSIGKey(tsigKey)

      val fullZoneName = if (zoneName.endsWith(".")) zoneName else zoneName + "."

      // First, create the zone itself
      val parentZoneName = fullZoneName.split("\\.",-1).drop(1).mkString(".")
      if (parentZoneName.isEmpty) {
         Left("Cannot create zone at root level")
      }

      // Create update for parent zone
      val createZoneUpdate = new Update(Name.fromString(parentZoneName + "."))

      // Create NS record for delegation
      val nsRecord = Record.newRecord(
        Name.fromString(fullZoneName),
        2,
        1,
        3600
      )

      createZoneUpdate.add(nsRecord)

      var response = resolver.send(createZoneUpdate)
      println(s"Response code: ${response.getRcode} (${Rcode.string(response.getRcode)})")
      if (response.getRcode != Rcode.NOERROR) {
         Left(s"Failed to create zone: ${Rcode.string(response.getRcode)} - ${response.toString}")
      }

      // Now add the zone contents
      val update = new Update(Name.fromString(fullZoneName))

      val primaryNs = "ns1.sample.com."
      val secondaryNs = "ns2.sample.com."
      val formattedEmail = adminEmail.replace('@', '.')

      // Create SOA Record
      val soa = new SOARecord(
        Name.fromString(fullZoneName),
        DClass.IN,
        3600, // TTL
        Name.fromString(primaryNs),
        Name.fromString(formattedEmail),
        System.currentTimeMillis() / 1000, // Serial number based on current time
        10800, // Refresh: 3 hours
        3600,  // Retry: 1 hour
        604800, // Expire: 1 week
        38400  // Minimum TTL: 10 hours
      )
      update.add(soa)

      // Add NS records
      val ns1 = new NSRecord(
        Name.fromString(fullZoneName),
        DClass.IN,
        3600,
        Name.fromString(primaryNs)
      )
      val ns2 = new NSRecord(
        Name.fromString(fullZoneName),
        DClass.IN,
        3600,
        Name.fromString(secondaryNs)
      )
      update.add(ns1)
      update.add(ns2)

      response = resolver.send(update)
      if (response.getRcode == Rcode.NOERROR) {
        Right(s"Zone $zoneName created successfully")
      } else {
        Left(s"Failed to populate zone: ${Rcode.string(response.getRcode)} - ${response.toString}")
      }
    } catch {
      case e: Exception =>
        println(s"Error creating zone: ${e.getMessage}")
        println(s"Stack trace: ${e.getStackTrace.mkString("\n")}")
        Left(s"Error creating zone: ${e.getMessage}")
    }
  }

  def testTSIGConnection(): Either[Throwable, Boolean] = {
    try {
      // Create resolver with TSIG key
      val resolver = new SimpleResolver(resolverHost)
      resolver.setPort(resolverPort)
      resolver.setTCP(true)

      // Create TSIG key
      val tsigKey = new TSIG(
        TSIG.HMAC_SHA1,
        Name.fromString(tsigKeyName),
        tsigSecret
      )
      resolver.setTSIGKey(tsigKey)

      // Create a test query
      val name = Name.fromString("ok.")
      val record = Record.newRecord(name, Type.SOA, DClass.IN)
      val message = Message.newQuery(record)

      // Send the query
      val response = resolver.send(message)

      // Print detailed response information
      println("TSIG Test Response:")
      println(s"Response Code: ${Rcode.string(response.getHeader.getRcode)}")
      println(s"TSIG Error: ${response}")
      println("Full Response:")
      println(response)

      // Check if TSIG verification passed
      val tsigState = response.isVerified()
      println(s"TSIG Verification: ${if (tsigState) "Passed" else "Failed"}")

      // Check TSIG key details
      println("\nTSIG Key Details:")
      println(s"Key Name: ${tsigKey}")


      Right(tsigState)
    } catch {
      case e: Exception =>
        println(s"TSIG Test Error: ${e.getMessage}")
        e.printStackTrace()
        Left(e)
    }
  }

  private def createResolver(): Either[Throwable, SimpleResolver] = {
    Try {
      val resolver = new SimpleResolver(resolverHost)
      resolver.setPort(resolverPort)
      resolver.setTCP(true)

      try {
        // Create TSIG key with proper error handling
        val tsigKey = new TSIG(
          TSIG.HMAC_SHA1,
          Name.fromString(tsigKeyName),
          tsigSecret
        )
        resolver.setTSIGKey(tsigKey)
      } catch {
        case e: Exception =>
          throw new Exception(s"Failed to create TSIG key: ${e.getMessage}", e)
      }

      resolver
    }.toEither
  }


  def createZoneFile(zoneName: String, adminEmail: String, ttl: Int): String = {
    s"""
       |TTL $ttl
       |@   IN  SOA     ns1.$zoneName. $adminEmail. (
       |                  1   ; Serial
       |             604800   ; Refresh
       |              86400   ; Retry
       |            2419200   ; Expire
       |             604800 ) ; Negative Cache TTL
       |;
       |@   IN  NS      ns1.$zoneName.
       |ns1 IN  A       192.168.1.1
       |""".stripMargin
  }

  // Function to update BIND9 configuration
  def updateBindConfig(zoneName: String): Unit = {
    val configContent = s"""
                           |zone "$zoneName" {
                           |    type master;
                           |    file "$zoneFilePath";
                           |};
                           |""".stripMargin

    try {
      val configFilePath = Paths.get("/etc/bind/named.conf.local")

      // Check if the file exists; create it if not
      if (!Files.exists(configFilePath)) {
        Files.createFile(configFilePath)
      }

      // Append the new zone configuration to the file
      Files.write(
        configFilePath,
        configContent.getBytes(StandardCharsets.UTF_8),
        StandardOpenOption.APPEND // Append content to the file
      )

      println(s"Zone configuration for $zoneName appended to named.conf.local")

    } catch {
      case e: IOException =>
        println(s"An error occurred while updating the BIND configuration: ${e.getMessage}")
    }
  }



  import scala.sys.process._

  def executeDockerCommand(containerId: String, command: String): Either[String, String] = {
    try {
      println("Executing docker command...")

      // Execute the command and capture output
      val dockerCmd = s"docker exec -u root $containerId $command"
      val result = dockerCmd.!!  // !! executes the command and returns output as string

      println(s"Command executed: $dockerCmd")
      println(s"Result: $result")

      Right(result)
    } catch {
      case e: Exception =>
        println(s"Error: ${e.getMessage}")
        Left(s"Docker command failed: ${e.getMessage}")
    }
  }

  def createZoneFileInContainer(containerId: String, zoneName: String, content: String): Either[String, String] = {
    // Escape quotes and special characters
    val escapedContent = content.replace("\"", "\\\"").replace("$", "\\$")
    println(escapedContent)


    // Use single quotes around the content
    val command = s"touch /var/bind/zones/default/${zoneName}hosts && echo '${escapedContent}' > /var/bind/zones/default/${zoneName}hosts"

    executeDockerCommand(containerId, command)
  }

  def updateBindConfigInContainer(containerId: String, zoneName: String): Either[String, String] = {
    val configContent = s"""
                           |zone "$zoneName" {
                           |    type master;
                           |    file "/var/bind/zones/default/${zoneName}hosts";
                           |    allow-update { key "vinyldns"; };
                           |    notify yes;
                           |};""".stripMargin

    // Use single quotes for shell command to avoid escaping issues
    val command = s"echo '$configContent' >> /etc/bind/named.conf.newzones"

    executeDockerCommand(containerId, command)
  }

  def setupNewZoneInContainer(containerId: String, zoneName: String, adminEmail: String, ttl: Int = 3600): Either[String, Unit] = {
    for {
      zoneContent <- Right(createZoneFile(zoneName, adminEmail, ttl))
      _ <- createZoneFileInContainer(containerId, zoneName, zoneContent)
      _ <- updateBindConfigInContainer(containerId, zoneName)
      // Reload BIND after changes
      _ <- executeDockerCommand(containerId, "rndc reload")
    } yield ()
  }

  // Your existing toCreateZoneMessage method
  def toCreateZoneMessage(newZoneName: String): Either[Throwable, Message] = {
    createZoneFile(newZoneName, "admin.test.com.",38400)
    updateBindConfig(newZoneName)
    for {
      resolver <- createResolver()
      result <- Try {
        val update = new Update(Name.fromString(newZoneName))

        val soaRecord = new SOARecord(
          Name.fromString(newZoneName),
          DClass.IN,
          defaultTTL,
          Name.fromString(s"ns1.${newZoneName}"),
          Name.fromString(s"admin.${newZoneName}"),
          System.currentTimeMillis() / 1000L,
          3600L,
          1800L,
          604800L,
          86400L
        )

        // Add records
        update.add(soaRecord)

        // Send update and handle response
        val response = resolver.send(update)
        println(s"Zone creation response for ${newZoneName}:")
        println(response)

        if (response.getHeader.getRcode == Rcode.NOERROR) {
          println(s"Zone ${newZoneName} created successfully")
        } else {
          val errorMsg = s"Failed to create zone ${newZoneName}. Response code: ${Rcode.string(response.getHeader.getRcode)}"
          println(errorMsg)
          if (response.getHeader.getRcode == Rcode.NOTAUTH) {
            println("TSIG authentication failed. Please check your TSIG key configuration.")
          }
          throw new Exception(errorMsg)
        }

        response
      }.toEither
    } yield result
  }





  def syncZone(zoneId: String, auth: AuthPrincipal): Result[ZoneCommandResult] =
    for {
      zone <- getZoneOrFail(zoneId)
      _ <- canChangeZone(auth, zone.name, zone.adminGroupId).toResult
      _ <- outsideSyncDelay(zone).toResult
      syncZoneChange <- ZoneChangeGenerator.forSync(zone, auth).toResult
      _ <- messageQueue.send(syncZoneChange).toResult[Unit]
    } yield syncZoneChange

  def getZone(zoneId: String, auth: AuthPrincipal): Result[ZoneInfo] =
    for {
      zone <- getZoneOrFail(zoneId)
      _ <- canSeeZone(auth, zone).toResult
      aclInfo <- getZoneAclDisplay(zone.acl)
      groupName <- getGroupName(zone.adminGroupId)
      accessLevel = getZoneAccess(auth, zone)
    } yield ZoneInfo(zone, aclInfo, groupName, accessLevel)

  def getCommonZoneDetails(zoneId: String, auth: AuthPrincipal): Result[ZoneDetails] =
    for {
      zone <- getZoneOrFail(zoneId)
      groupName <- getGroupName(zone.adminGroupId)
    } yield ZoneDetails(zone, groupName)

  def getZoneByName(zoneName: String, auth: AuthPrincipal): Result[ZoneInfo] =
    for {
      zone <- getZoneByNameOrFail(ensureTrailingDot(zoneName))
      aclInfo <- getZoneAclDisplay(zone.acl)
      groupName <- getGroupName(zone.adminGroupId)
      accessLevel = getZoneAccess(auth, zone)
    } yield ZoneInfo(zone, aclInfo, groupName, accessLevel)

  // List zones. Uses zone name as default while using search to list zones or by admin group name if selected.
  def listZones(
      authPrincipal: AuthPrincipal,
      nameFilter: Option[String] = None,
      startFrom: Option[String] = None,
      maxItems: Int = 100,
      searchByAdminGroup: Boolean = false,
      ignoreAccess: Boolean = false,
      includeReverse: Boolean = true
  ): Result[ListZonesResponse] = {
    if(!searchByAdminGroup || nameFilter.isEmpty){
      for {
        listZonesResult <- zoneRepository.listZones(
          authPrincipal,
          nameFilter,
          startFrom,
          maxItems,
          ignoreAccess,
          includeReverse
      )
      zones = listZonesResult.zones
      groupIds = zones.map(_.adminGroupId).toSet
      groups <- groupRepository.getGroups(groupIds)
      zoneSummaryInfos = zoneSummaryInfoMapping(zones, authPrincipal, groups)
    } yield ListZonesResponse(
      zoneSummaryInfos,
      listZonesResult.zonesFilter,
      listZonesResult.startFrom,
      listZonesResult.nextId,
      listZonesResult.maxItems,
      listZonesResult.ignoreAccess,
      listZonesResult.includeReverse
    )}
    else {
      for {
        groupIds <- getGroupsIdsByName(nameFilter.get)
        listZonesResult <- zoneRepository.listZonesByAdminGroupIds(
          authPrincipal,
          startFrom,
          maxItems,
          groupIds,
          ignoreAccess,
          includeReverse
        )
        zones = listZonesResult.zones
        groups <- groupRepository.getGroups(groupIds)
        zoneSummaryInfos = zoneSummaryInfoMapping(zones, authPrincipal, groups)
      } yield ListZonesResponse(
        zoneSummaryInfos,
        nameFilter,
        listZonesResult.startFrom,
        listZonesResult.nextId,
        listZonesResult.maxItems,
        listZonesResult.ignoreAccess,
        listZonesResult.includeReverse
      )
    }
  }.toResult

  def listDeletedZones(
                        authPrincipal: AuthPrincipal,
                        nameFilter: Option[String] = None,
                        startFrom: Option[String] = None,
                        maxItems: Int = 100,
                        ignoreAccess: Boolean = false
                      ): Result[ListDeletedZoneChangesResponse] = {
    for {
      listZonesChangeResult <- zoneChangeRepository.listDeletedZones(
        authPrincipal,
        nameFilter,
        startFrom,
        maxItems,
        ignoreAccess
      )
      zoneChanges = listZonesChangeResult.zoneDeleted
      groupIds = zoneChanges.map(_.zone.adminGroupId).toSet
      groups <- groupRepository.getGroups(groupIds)
      userId = zoneChanges.map(_.userId).toSet
      users <- userRepository.getUsers(userId,None,None)
      zoneDeleteSummaryInfos = ZoneChangeDeletedInfoMapping(zoneChanges, authPrincipal, groups, users)
    } yield {
      ListDeletedZoneChangesResponse(
        zoneDeleteSummaryInfos,
        listZonesChangeResult.zoneChangeFilter,
        listZonesChangeResult.nextId,
        listZonesChangeResult.startFrom,
        listZonesChangeResult.maxItems,
        listZonesChangeResult.ignoreAccess
      )
    }
  }.toResult

  private def ZoneChangeDeletedInfoMapping(
                                            zoneChange: List[ZoneChange],
                                            auth: AuthPrincipal,
                                            groups: Set[Group],
                                            users: ListUsersResults
                                          ): List[ZoneChangeDeletedInfo] =
    zoneChange.map { zc =>
      val groupName = groups.find(_.id == zc.zone.adminGroupId) match {
        case Some(group) => group.name
        case None => "Unknown group name"
      }
      val userName = users.users.find(_.id == zc.userId) match {
        case Some(user) => user.userName
        case None => "Unknown user name"
      }
      val zoneAccess = getZoneAccess(auth, zc.zone)
      ZoneChangeDeletedInfo(zc, groupName,userName, zoneAccess)
    }

  def zoneSummaryInfoMapping(
      zones: List[Zone],
      auth: AuthPrincipal,
      groups: Set[Group]
  ): List[ZoneSummaryInfo] =
    zones.map { zn =>
      val groupName = groups.find(_.id == zn.adminGroupId) match {
        case Some(group) => group.name
        case None => "Unknown group name"
      }
      val zoneAccess = getZoneAccess(auth, zn)
      ZoneSummaryInfo(zn, groupName, zoneAccess)
    }

  def listZoneChanges(
      zoneId: String,
      authPrincipal: AuthPrincipal,
      startFrom: Option[String] = None,
      maxItems: Int = 100
  ): Result[ListZoneChangesResponse] =
    for {
      zone <- getZoneOrFail(zoneId)
      _ <- canSeeZoneChange(authPrincipal, zone).toResult
      zoneChangesResults <- zoneChangeRepository
        .listZoneChanges(zone.id, startFrom, maxItems)
        .toResult[ListZoneChangesResults]
    } yield ListZoneChangesResponse(zone.id, zoneChangesResults)

  def listFailedZoneChanges(
                             authPrincipal: AuthPrincipal,
                             startFrom: Int= 0,
                             maxItems: Int = 100
                           ): Result[ListFailedZoneChangesResponse] =
    for {
      zoneChangesFailedResults <- zoneChangeRepository
        .listFailedZoneChanges(maxItems, startFrom)
        .toResult[ListFailedZoneChangesResults]
      _ <- zoneAccess(zoneChangesFailedResults.items, authPrincipal).toResult
    } yield
      ListFailedZoneChangesResponse(
        zoneChangesFailedResults.items,
        zoneChangesFailedResults.nextId,
        startFrom,
        maxItems
      )

  def zoneAccess(
                  zoneCh: List[ZoneChange],
                  auth: AuthPrincipal
                ): List[Result[Unit]] =
    zoneCh.map { zn =>
      canSeeZone(auth, zn.zone).toResult
    }

  def addACLRule(
      zoneId: String,
      aclRuleInfo: ACLRuleInfo,
      authPrincipal: AuthPrincipal
  ): Result[ZoneCommandResult] = {
    val newRule = ACLRule(aclRuleInfo)
    for {
      zone <- getZoneOrFail(zoneId)
      _ <- canChangeZone(authPrincipal, zone.name, zone.adminGroupId).toResult
      _ <- isValidAclRule(newRule).toResult
      zoneChange <- ZoneChangeGenerator
        .forUpdate(
          newZone = zone.addACLRule(newRule),
          oldZone = zone,
          authPrincipal = authPrincipal,
          crypto
        )
        .toResult
      _ <- messageQueue.send(zoneChange).toResult[Unit]
    } yield zoneChange
  }

  def deleteACLRule(
      zoneId: String,
      aclRuleInfo: ACLRuleInfo,
      authPrincipal: AuthPrincipal
  ): Result[ZoneCommandResult] = {
    val newRule = ACLRule(aclRuleInfo)
    for {
      zone <- getZoneOrFail(zoneId)
      _ <- canChangeZone(authPrincipal, zone.name, zone.adminGroupId).toResult
      zoneChange <- ZoneChangeGenerator
        .forUpdate(
          newZone = zone.deleteACLRule(newRule),
          oldZone = zone,
          authPrincipal = authPrincipal,
          crypto
        )
        .toResult
      _ <- messageQueue.send(zoneChange).toResult[Unit]
    } yield zoneChange
  }

  def getGroupsIdsByName(groupName: String): IO[Set[String]] = {
    groupRepository.getGroupsByName(groupName).map(x => x.map(_.id))
  }

  def getBackendIds(): Result[List[String]] =
    backendResolver.ids.toList.toResult

  def isValidCronString(maybeString: String): Boolean = {
    val isValid = try {
      val cronDefinition: CronDefinition = CronDefinitionBuilder.instanceDefinitionFor(CronType.QUARTZ)
      val parser: CronParser = new CronParser(cronDefinition)
      val quartzCron = parser.parse(maybeString)
      quartzCron.validate
      true
    }
    catch {
      case _: Exception =>
        false
    }
    isValid
  }

  def validateCronString(isValid: Boolean): Either[Throwable, Unit] =
    ensuring(
      InvalidRequest("Invalid cron expression. Please enter a valid cron expression in 'recurrenceSchedule'.")
    )(
      isValid
    )

  def zoneDoesNotExist(zoneName: String): Result[Unit] =
    zoneRepository
      .getZoneByName(zoneName)
      .map {
        case Some(existingZone) if existingZone.status != ZoneStatus.Deleted =>
          ZoneAlreadyExistsError(
            s"Zone with name $zoneName already exists. " +
              s"Please contact ${existingZone.email} to request access to the zone."
          ).asLeft
        case _ => ().asRight
      }
      .toResult

  def canScheduleZoneSync(auth: AuthPrincipal): Either[Throwable, Unit] =
    ensuring(
      NotAuthorizedError(s"User '${auth.signedInUser.userName}' is not authorized to schedule zone sync in this zone.")
    )(
      auth.isSystemAdmin
    )

  def adminGroupExists(groupId: String): Result[Unit] =
    groupRepository
      .getGroup(groupId)
      .map {
        case Some(_) => ().asRight
        case None => InvalidGroupError(s"Admin group with ID $groupId does not exist").asLeft
      }
      .toResult

  def getGroupName(groupId: String): Result[String] = {
    groupRepository.getGroup(groupId).map {
      case Some(group) => group.name
      case None => "Unknown group name"
    }
  }.toResult

  def getZoneOrFail(zoneId: String): Result[Zone] =
    zoneRepository
      .getZone(zoneId)
      .orFail(ZoneNotFoundError(s"Zone with id $zoneId does not exists"))
      .toResult[Zone]

  def getZoneByNameOrFail(zoneName: String): Result[Zone] =
    zoneRepository
      .getZoneByName(zoneName)
      .orFail(ZoneNotFoundError(s"Zone with name $zoneName does not exists"))
      .toResult[Zone]

  def validateZoneConnectionIfChanged(newZone: Zone, existingZone: Zone): Result[Unit] =
    if (newZone.connection != existingZone.connection
      || newZone.transferConnection != existingZone.transferConnection) {
      connectionValidator.validateZoneConnections(newZone)
    } else {
      ().toResult
    }

  def getZoneAclDisplay(zoneAcl: ZoneACL): Result[ZoneACLInfo] = {
    val (withUserId, without) = zoneAcl.rules.partition(_.userId.isDefined)
    val (withGroupId, _) = without.partition(_.groupId.isDefined)

    val userIdsToFetch = withUserId.map(_.userId.get)
    val groupIdsToFetch = withGroupId.map(_.groupId.get)

    for {
      users <- userRepository.getUsers(userIdsToFetch, None, None).map(_.users).toResult[Seq[User]]
      groups <- groupRepository.getGroups(groupIdsToFetch).toResult[Set[Group]]
      groupMap = groups.map(g => (g.id, g.name)).toMap
      userMap = users.map(u => (u.id, u.userName)).toMap
      ruleInfos = zoneAcl.rules.map { rule =>
        (rule.userId, rule.groupId) match {
          case (Some(uid), _) => ACLRuleInfo(rule, userMap.get(uid))
          case (_, Some(gid)) => ACLRuleInfo(rule, groupMap.get(gid))
          case _ => ACLRuleInfo(rule, Some("All Users"))
        }
      }
    } yield ZoneACLInfo(ruleInfos.filter(_.displayName.isDefined))
  }
}
