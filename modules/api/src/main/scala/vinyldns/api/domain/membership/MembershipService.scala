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

package vinyldns.api.domain.membership

import cats.effect.IO
import cats.implicits._
import scalikejdbc.DB
import vinyldns.api.Interfaces._
import vinyldns.api.repository.ApiDataAccessor
import vinyldns.core.domain.auth.AuthPrincipal
import vinyldns.core.domain.membership.LockStatus.LockStatus
import vinyldns.core.domain.zone.ZoneRepository
import vinyldns.core.domain.membership._
import vinyldns.core.domain.record.RecordSetRepository
import vinyldns.core.Messages._
import vinyldns.mysql.TransactionProvider

object MembershipService {
  def apply(dataAccessor: ApiDataAccessor): MembershipService =
    new MembershipService(
      dataAccessor.groupRepository,
      dataAccessor.userRepository,
      dataAccessor.membershipRepository,
      dataAccessor.zoneRepository,
      dataAccessor.groupChangeRepository,
      dataAccessor.recordSetRepository
    )
}

class MembershipService(
    groupRepo: GroupRepository,
    userRepo: UserRepository,
    membershipRepo: MembershipRepository,
    zoneRepo: ZoneRepository,
    groupChangeRepo: GroupChangeRepository,
    recordSetRepo: RecordSetRepository
) extends MembershipServiceAlgebra with TransactionProvider {

  import MembershipValidations._

  def createGroup(inputGroup: Group, authPrincipal: AuthPrincipal): Result[Group] = {
    val newGroup = inputGroup.addAdminUser(authPrincipal.signedInUser)
    val adminMembers = inputGroup.adminUserIds
    val nonAdminMembers = inputGroup.memberIds.diff(adminMembers)
    for {
      _ <- groupValidation(newGroup)
      _ <- hasMembersAndAdmins(newGroup).toResult
      _ <- groupWithSameNameDoesNotExist(newGroup.name)
      _ <- usersExist(newGroup.memberIds)
      _ <- createGroupData(GroupChange.forAdd(newGroup, authPrincipal), newGroup, adminMembers, nonAdminMembers).toResult[Unit]
    } yield newGroup
  }

  def updateGroup(
      groupId: String,
      name: String,
      email: String,
      description: Option[String],
      memberIds: Set[String],
      adminUserIds: Set[String],
      authPrincipal: AuthPrincipal
  ): Result[Group] =
    for {
      existingGroup <- getExistingGroup(groupId)
      newGroup = existingGroup.withUpdates(name, email, description, memberIds, adminUserIds)
      _ <- groupValidation(newGroup)
      _ <- canEditGroup(existingGroup, authPrincipal).toResult
      addedAdmins = newGroup.adminUserIds.diff(existingGroup.adminUserIds)
      // new non-admin members ++ admins converted to non-admins
      addedNonAdmins = newGroup.memberIds.diff(existingGroup.memberIds).diff(addedAdmins) ++
        existingGroup.adminUserIds.diff(newGroup.adminUserIds).intersect(newGroup.memberIds)
      removedMembers = existingGroup.memberIds.diff(newGroup.memberIds)
      _ <- hasMembersAndAdmins(newGroup).toResult
      _ <- usersExist(addedNonAdmins)
      _ <- differentGroupWithSameNameDoesNotExist(newGroup.name, existingGroup.id)
      _ <- updateGroupData(GroupChange.forUpdate(newGroup, existingGroup, authPrincipal), newGroup, existingGroup, addedAdmins, addedNonAdmins, removedMembers).toResult[Unit]
    } yield newGroup

  def deleteGroup(groupId: String, authPrincipal: AuthPrincipal): Result[Group] =
    for {
      existingGroup <- getExistingGroup(groupId)
      _ <- canEditGroup(existingGroup, authPrincipal).toResult
      _ <- isNotZoneAdmin(existingGroup)
      _ <- isNotRecordOwnerGroup(existingGroup)
      _ <- isNotInZoneAclRule(existingGroup)
      deletedGroup <- deleteGroupData(GroupChange.forDelete(existingGroup, authPrincipal), existingGroup).toResult[Group]
    } yield deletedGroup

  def createGroupData(
   groupChangeData: GroupChange,
   newGroup: Group,
   adminMembers: Set[String],
   nonAdminMembers: Set[String]
  ): IO[Unit] =
    executeWithinTransaction { db: DB =>
      for {
        _ <- groupChangeRepo.save(db, groupChangeData)
        _ <- groupRepo.save(db, newGroup)
        // save admin and non-admin members separately
        _ <- membershipRepo
          .saveMembers(db, newGroup.id, adminMembers, isAdmin = true)
        _ <- membershipRepo
          .saveMembers(db, newGroup.id, nonAdminMembers, isAdmin = false)
      } yield ()
    }

  def updateGroupData(
   groupChangeData: GroupChange,
   newGroup: Group,
   existingGroup: Group,
   addedAdmins: Set[String],
   addedNonAdmins: Set[String],
   removedMembers: Set[String]
  ): IO[Unit] =
    executeWithinTransaction { db: DB =>
      for {
        _ <- groupChangeRepo
          .save(db, groupChangeData)
        _ <- groupRepo.save(db, newGroup)
        // save admin and non-admin members separately
        _ <- membershipRepo
          .saveMembers(db, existingGroup.id, addedAdmins, isAdmin = true)
        _ <- membershipRepo
          .saveMembers(db, existingGroup.id, addedNonAdmins, isAdmin = false)
        _ <- membershipRepo.removeMembers(db, existingGroup.id, removedMembers)
      } yield ()
    }

  def deleteGroupData(
   groupChangeData: GroupChange,
   existingGroup: Group,
  ): IO[Group] =
    executeWithinTransaction { db: DB =>
      for {
        _ <- groupChangeRepo
          .save(db, groupChangeData)
        _ <- membershipRepo
          .removeMembers(db, existingGroup.id, existingGroup.memberIds)
        deletedGroup = existingGroup.copy(status = GroupStatus.Deleted)
        _ <- groupRepo.delete(deletedGroup)
      } yield deletedGroup
    }

  def getGroup(id: String, authPrincipal: AuthPrincipal): Result[Group] =
    for {
      group <- getExistingGroup(id)
      _ <- canSeeGroup(id, authPrincipal).toResult
    } yield group

  def listMembers(
      groupId: String,
      startFrom: Option[String],
      maxItems: Int,
      authPrincipal: AuthPrincipal
  ): Result[ListMembersResponse] =
    for {
      group <- getExistingGroup(groupId)
      _ <- canSeeGroup(groupId, authPrincipal).toResult
      result <- getUsers(group.memberIds, startFrom, Some(maxItems))
    } yield ListMembersResponse(
      result.users.map(MemberInfo(_, group)),
      startFrom,
      result.lastEvaluatedId,
      maxItems
    )

  def listAdmins(groupId: String, authPrincipal: AuthPrincipal): Result[ListAdminsResponse] =
    for {
      group <- getExistingGroup(groupId)
      _ <- canSeeGroup(groupId, authPrincipal).toResult
      result <- getUsers(group.adminUserIds, None, None)
    } yield ListAdminsResponse(result.users.map(UserInfo(_)))

  def listMyGroups(
      groupNameFilter: Option[String],
      startFrom: Option[String],
      maxItems: Int,
      authPrincipal: AuthPrincipal,
      ignoreAccess: Boolean
  ): Result[ListMyGroupsResponse] = {
    val groupsCall =
      if (authPrincipal.isSystemAdmin || ignoreAccess) {
        groupRepo.getAllGroups()
      } else {
        groupRepo.getGroups(authPrincipal.memberGroupIds.toSet)
      }

    groupsCall.map { grp =>
      pageListGroupsResponse(grp.toList, groupNameFilter, startFrom, maxItems, ignoreAccess)
    }
  }.toResult

  def pageListGroupsResponse(
      allGroups: Seq[Group],
      groupNameFilter: Option[String],
      startFrom: Option[String],
      maxItems: Int,
      ignoreAccess: Boolean
  ): ListMyGroupsResponse = {
    val allMyGroups = allGroups
      .filter(_.status == GroupStatus.Active)
      .sortBy(_.id)
      .map(GroupInfo.apply)

    val filtered = allMyGroups
      .filter(grp => groupNameFilter.forall(grp.name.contains(_)))
      .filter(grp => startFrom.forall(grp.id > _))

    val nextId = if (filtered.length > maxItems) Some(filtered(maxItems - 1).id) else None
    val groups = filtered.take(maxItems)

    ListMyGroupsResponse(groups, groupNameFilter, startFrom, nextId, maxItems, ignoreAccess)
  }

  def getGroupActivity(
      groupId: String,
      startFrom: Option[String],
      maxItems: Int,
      authPrincipal: AuthPrincipal
  ): Result[ListGroupChangesResponse] =
    for {
      _ <- canSeeGroup(groupId, authPrincipal).toResult
      result <- groupChangeRepo
        .getGroupChanges(groupId, startFrom, maxItems)
        .toResult[ListGroupChangesResults]
    } yield ListGroupChangesResponse(
      result.changes.map(GroupChangeInfo.apply),
      startFrom,
      result.lastEvaluatedTimeStamp,
      maxItems
    )

  def getUsers(
      userIds: Set[String],
      startFrom: Option[String] = None,
      pageSize: Option[Int] = None
  ): Result[ListUsersResults] =
    userRepo
      .getUsers(userIds, startFrom, pageSize)
      .toResult[ListUsersResults]

  def getExistingUser(userId: String): Result[User] =
    userRepo
      .getUser(userId)
      .orFail(UserNotFoundError(s"User with ID $userId was not found"))
      .toResult[User]

  def getExistingGroup(groupId: String): Result[Group] =
    groupRepo
      .getGroup(groupId)
      .orFail(GroupNotFoundError(s"Group with ID $groupId was not found"))
      .toResult[Group]

  // Validate group details. Group name and email cannot be empty
  def groupValidation(group: Group): Result[Unit] = {
    Option(group) match {
      case Some(value) if Option(value.name).forall(_.trim.isEmpty) || Option(value.email).forall(_.trim.isEmpty) =>
        GroupValidationError(GroupValidationErrorMsg).asLeft
      case _ =>
        ().asRight
    }
  }.toResult

  def groupWithSameNameDoesNotExist(name: String): Result[Unit] =
    groupRepo
      .getGroupByName(name)
      .map {
        case Some(existingGroup) if existingGroup.status != GroupStatus.Deleted =>
          GroupAlreadyExistsError(GroupAlreadyExistsErrorMsg.format(name, existingGroup.email)).asLeft
        case _ =>
          ().asRight
      }
      .toResult

  def usersExist(userIds: Set[String]): Result[Unit] = {
    userRepo.getUsers(userIds, None, None).map { results =>
      val delta = userIds.diff(results.users.map(_.id).toSet)
      if (delta.isEmpty)
        ().asRight
      else
        UserNotFoundError(s"Users [ ${delta.mkString(",")} ] were not found").asLeft
    }
  }.toResult

  def differentGroupWithSameNameDoesNotExist(name: String, groupId: String): Result[Unit] =
    groupRepo
      .getGroupByName(name)
      .map {
        case Some(existingGroup)
            if existingGroup.status != GroupStatus.Deleted && existingGroup.id != groupId =>
          GroupAlreadyExistsError(GroupAlreadyExistsErrorMsg.format(name, existingGroup.email)).asLeft
        case _ =>
          ().asRight
      }
      .toResult

  def isNotZoneAdmin(group: Group): Result[Unit] =
    zoneRepo
      .getZonesByAdminGroupId(group.id)
      .map { zones =>
        ensuring(InvalidGroupRequestError(ZoneAdminError.format(group.name)))(
          zones.isEmpty
        )
      }
      .toResult

  def isNotRecordOwnerGroup(group: Group): Result[Unit] =
    recordSetRepo
      .getFirstOwnedRecordByGroup(group.id)
      .map { rsId =>
        ensuring(
          InvalidGroupRequestError(
            RecordSetOwnerError.format(group.name, rsId)
          )
        )(rsId.isEmpty)
      }
      .toResult

  def isNotInZoneAclRule(group: Group): Result[Unit] =
    zoneRepo
      .getFirstOwnedZoneAclGroupId(group.id)
      .map { zId =>
        ensuring(
          InvalidGroupRequestError(
            ACLRuleError.format(group.name, zId)
          )
        )(zId.isEmpty)
      }
      .toResult

  def updateUserLockStatus(
      userId: String,
      lockStatus: LockStatus,
      authPrincipal: AuthPrincipal
  ): Result[User] =
    for {
      _ <- isSuperAdmin(authPrincipal).toResult
      existingUser <- getExistingUser(userId)
      newUser = existingUser.updateUserLockStatus(lockStatus)
      _ <- userRepo.save(newUser).toResult[User]
    } yield newUser
}
