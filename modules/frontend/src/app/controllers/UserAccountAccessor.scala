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

package controllers

import cats.effect.{ContextShift, IO}
import cats.implicits._
import javax.inject.{Inject, Singleton}
import java.time.Instant
import org.slf4j.LoggerFactory
import vinyldns.core.domain.membership._
import java.time.temporal.ChronoUnit

@Singleton
class UserAccountAccessor @Inject() (users: UserRepository, changes: UserChangeRepository) {

  implicit val cs: ContextShift[IO] = IO.contextShift(scala.concurrent.ExecutionContext.global)
  private val logger = LoggerFactory.getLogger(classOf[UserAccountAccessor])

  /**
    * Lookup a user in the store. Using identifier as the user id and/or name
    *
    * @param identifier
    * @return Success(Some(user account)) on success, Success(None) if the user does not exist and Failure when there
    *         was an error.
    */
  def get(identifier: String): IO[Option[User]] =
    {
      val header = VinylDNS.operationKeyword("GET", "users/get")
      val common = Seq("backend.method" -> "GET", "backend.path" -> "users/get", "identifier" -> identifier)
      val startNs = VinylDNS.logStart(logger, header, common)
      users
      .getUser(identifier)
      .flatMap {
        case None => users.getUserByName(identifier)
        case found => IO(found)
      }
        .flatTap { result =>
          VinylDNS.logResult(
            logger,
            header,
            startNs,
            if (result.isDefined) 200 else 404,
            common,
            successWhen = _ == 200
          )
          IO.unit
        }
    }

  def create(user: User): IO[User] =
    {
      val header = VinylDNS.operationKeyword("POST", "users/create")
      val common = Seq("backend.method" -> "POST", "backend.path" -> "users/create", "user" -> user.userName)
      val startNs = VinylDNS.logStart(logger, header, common)
      (for {
      _ <- users.save(user)
      _ <- changes.save(UserChange.CreateUser(user, "system", Instant.now.truncatedTo(ChronoUnit.MILLIS)))
      } yield user).flatTap { _ =>
        VinylDNS.logResult(logger, header, startNs, 201, common)
        IO.unit
      }
    }

  def update(user: User, oldUser: User): IO[User] =
    {
      val header = VinylDNS.operationKeyword("PUT", "users/update")
      val common = Seq("backend.method" -> "PUT", "backend.path" -> "users/update", "user" -> user.userName)
      val startNs = VinylDNS.logStart(logger, header, common)
      (for {
      _ <- users.save(user)
      _ <- changes.save(UserChange.UpdateUser(user, "system", Instant.now.truncatedTo(ChronoUnit.MILLIS), oldUser))
      } yield user).flatTap { _ =>
        VinylDNS.logResult(logger, header, startNs, 200, common)
        IO.unit
      }
    }

  def getUserByKey(key: String): IO[Option[User]] =
    {
      val header = VinylDNS.operationKeyword("GET", "users/access-key")
      val common = Seq("backend.method" -> "GET", "backend.path" -> "users/access-key")
      val startNs = VinylDNS.logStart(logger, header, common)
      users.getUserByAccessKey(key).flatTap { result =>
        VinylDNS.logResult(
          logger,
          header,
          startNs,
          if (result.isDefined) 200 else 404,
          common,
          successWhen = _ == 200
        )
        IO.unit
      }
    }

  def getAllUsers: IO[List[User]] =
    {
      val header = VinylDNS.operationKeyword("GET", "users/all")
      val common = Seq("backend.method" -> "GET", "backend.path" -> "users/all")
      val startNs = VinylDNS.logStart(logger, header, common)
      users.getAllUsers.flatTap { result =>
        VinylDNS.logResult(
          logger,
          header,
          startNs,
          200,
          common,
          extraFields = Seq("count" -> result.size.toString)
        )
        IO.unit
      }
    }

  def lockUsers(usersToLock: List[User]): IO[List[User]] = {
    val header = VinylDNS.operationKeyword("PUT", "users/lock")
    val common = Seq("backend.method" -> "PUT", "backend.path" -> "users/lock", "count" -> usersToLock.size.toString)
    val startNs = VinylDNS.logStart(logger, header, common)
    val currentTime = Instant.now.truncatedTo(ChronoUnit.MILLIS)
    for {
      lockedUsers <- users.save(usersToLock.map(_.copy(lockStatus = LockStatus.Locked)))
      _ <- usersToLock
        .zip(lockedUsers)
        .map {
          case (oldUser, newUser) =>
            changes.save(UserChange.UpdateUser(newUser, "system", currentTime, oldUser))
        }
        .parSequence
      _ <- IO {
        VinylDNS.logResult(logger, header, startNs, 200, common)
      }
    } yield lockedUsers
  }
}
