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

import actions.SecuritySupport
import javax.inject.{Inject, Singleton}
import org.slf4j.LoggerFactory
import play.api.{Configuration, Environment}
import play.api.mvc._
import play.filters.csrf.CSRF
import vinyldns.core.logging.RequestTracing

import scala.concurrent.ExecutionContext.Implicits.global
import scala.concurrent.Future
import scala.io.Source
import scala.util.control.NonFatal

/*
 * Controller for page routes — serves the React SPA for all authenticated routes.
 * Play injects the CSRF token into <head> so React can read it via:
 *   document.getElementById('csrf').getAttribute('content')
 */
@Singleton
class FrontendController @Inject() (
    components: ControllerComponents,
    configuration: Configuration,
    securitySupport: SecuritySupport,
    env: Environment
) extends AbstractController(components) {

  private val logger = LoggerFactory.getLogger(classOf[FrontendController])
  private val userAction = securitySupport.frontendAction

  private def withFrontendLog(name: String)(
      f: Request[AnyContent] => Future[Result]
  ): Action[AnyContent] = userAction.async { implicit request =>
    val traceId = RequestTracing.extractTraceHeader(request.headers.toSimpleMap)._2
    val header = VinylDNS.operationKeyword(request.method, name)
    val common = Seq(
      "frontend.method" -> request.method,
      "frontend.path" -> request.path,
      "backend.method" -> request.method,
      "backend.path" -> name,
      "trace.id" -> traceId
    )

    val startNs = VinylDNS.logStart(logger, header, common)
    f(request)
      .map { result =>
        VinylDNS.logResult(logger, header, startNs, result.header.status, common)
        result
      }
      .recoverWith {
        case NonFatal(e) =>
          VinylDNS.logFailure(logger, header, startNs, e, common)
          Future.failed(e)
      }
  }

  /**
   * Reads public/index.html and injects the Play CSRF token into <head>.
   * Tries the classpath first (production: bundled in JAR via sbt dist),
   * then falls back to the filesystem (dev: built to public/ by npm run build).
   */
  private def serveReactApp(implicit request: Request[AnyContent]): Future[Result] = {
    val csrfToken = CSRF.getToken.map(_.value).getOrElse("")
    val contentOpt: Option[String] =
      env.resourceAsStream("public/index.html")
        .orElse {
          val f = new java.io.File(env.rootPath, "public/index.html")
          if (f.exists()) Some(new java.io.FileInputStream(f)) else None
        }
        .map { is =>
          val src = Source.fromInputStream(is, "UTF-8")
          try src.mkString finally src.close()
        }
    contentOpt match {
      case Some(content) =>
        val html = content.replace("<head>", s"""<head>\n    <meta id="csrf" name="csrf-token" content="$csrfToken" />""")
        Future.successful(Ok(html).as("text/html"))
      case None =>
        logger.warn("React index.html not found — run: npm run build")
        Future.successful(ServiceUnavailable("React app not built. Run: npm run build").as("text/plain"))
    }
  }

  def loginPage(): Action[AnyContent]  = securitySupport.loginPage()
  def noAccess(): Action[AnyContent]   = securitySupport.noAccess()
  def logout(): Action[AnyContent]     = securitySupport.logout()

  def index(): Action[AnyContent]                           = withFrontendLog("frontend/index")(req => serveReactApp(req))
  def catchAll(path: String): Action[AnyContent]           = withFrontendLog(s"frontend/$path")(req => serveReactApp(req))
  def viewAllGroups(): Action[AnyContent]                  = withFrontendLog("frontend/groups")(req => serveReactApp(req))
  def viewGroup(groupId: String): Action[AnyContent]       = withFrontendLog(s"frontend/groups/$groupId")(req => serveReactApp(req))
  def viewAllZones(): Action[AnyContent]                   = withFrontendLog("frontend/zones")(req => serveReactApp(req))
  def viewZone(zoneId: String): Action[AnyContent]         = withFrontendLog(s"frontend/zones/$zoneId")(req => serveReactApp(req))
  def viewRecordSets(): Action[AnyContent]                 = withFrontendLog("frontend/recordsets")(req => serveReactApp(req))
  def viewAllBatchChanges(): Action[AnyContent]            = withFrontendLog("frontend/dnschanges")(req => serveReactApp(req))
  def viewBatchChange(batchId: String): Action[AnyContent] = withFrontendLog(s"frontend/dnschanges/$batchId")(req => serveReactApp(req))
  def viewNewBatchChange(): Action[AnyContent]             = withFrontendLog("frontend/dnschanges/new")(req => serveReactApp(req))
}
