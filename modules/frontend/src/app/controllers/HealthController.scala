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

import javax.inject.{Inject, Singleton}
import org.slf4j.LoggerFactory
import play.api.mvc.{AbstractController, Action, AnyContent, ControllerComponents}
import vinyldns.core.health.HealthService

@Singleton
class HealthController @Inject() (components: ControllerComponents, healthService: HealthService)
    extends AbstractController(components)
    with CacheHeader {

  private val logger = LoggerFactory.getLogger(classOf[HealthController])

  def health(): Action[AnyContent] = Action { implicit request =>
    val header = VinylDNS.operationKeyword(request.method, "health")
    val common = Seq(
      "frontend.method" -> request.method,
      "frontend.path" -> request.path,
      "backend.method" -> request.method,
      "backend.path" -> "health"
    )
    val startNs = VinylDNS.logStart(logger, header, common)

    healthService
      .checkHealth()
      .map {
        case Nil =>
          val result = Ok("OK").withHeaders(cacheHeaders: _*)
          VinylDNS.logResult(logger, header, startNs, result.header.status, common)
          result
        case _ =>
          val result = InternalServerError("There was an internal server error.").withHeaders(cacheHeaders: _*)
          VinylDNS.logResult(logger, header, startNs, result.header.status, common)
          result
      }
      .unsafeRunSync()
  }
}
