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

package logger

import java.io.File
import play.api.{Configuration, Environment, LoggerConfigurator, Mode}

import scala.util.Try

/**
  * Play LoggerConfigurator backed by log4j2.
  *
  * log4j2.xml in conf/ provides the base configuration. Log-level overrides
  * can be placed in application.conf using Play-style keys:
  *
  *   logger.root        = INFO
  *   logger.play        = WARN
  *   logger.application = DEBUG
  *   logger.com.example = TRACE
  */
class Log4j2LoggerConfigurator extends LoggerConfigurator {

  @volatile private var initialized = false

  private def fileFromSystemOrEnv: Option[File] =
    Option(System.getProperty("log4j.configurationFile"))
      .orElse(Option(System.getenv("LOG4J_CONFIGURATION_FILE")))
      .map(_.trim)
      .filter(_.nonEmpty)
      .map(new File(_))

  private def initFromFile(file: File): Unit =
    if (!initialized && file.exists()) {
      Try(org.apache.logging.log4j.core.config.Configurator.initialize(null, file.toURI.toString)).foreach { _ =>
        initialized = true
      }
    }

  def init(rootPath: File, mode: Mode): Unit = {
    fileFromSystemOrEnv.foreach(initFromFile)

    // Prefer deterministic root-based paths; avoid cwd-dependent resolution in prod.
    val candidatePaths = Seq(
      new File(rootPath, "conf/log4j2.xml"),                          // Workspace root
      new File(rootPath, "modules/frontend/conf/log4j2.xml"),         // From workspace root
      new File(rootPath.getParentFile, "frontend/conf/log4j2.xml")    // Module root
    )
    candidatePaths.foreach(initFromFile)
  }

  def configure(env: Environment): Unit = {
    fileFromSystemOrEnv.foreach(initFromFile)

    // Prefer deterministic environment-root-based paths.
    val candidatePaths = Seq(
      new File(env.rootPath, "conf/log4j2.xml"),
      new File(env.rootPath, "modules/frontend/conf/log4j2.xml"),
      new File(env.rootPath.getParentFile, "frontend/conf/log4j2.xml")
    )
    candidatePaths.foreach(initFromFile)
  }

  /** Applies logger.* overrides from application.conf to the running log4j2 context. */
  def configure(
      env: Environment,
      configuration: Configuration,
      optionalProperties: Map[String, String]
  ): Unit = {
    import org.apache.logging.log4j.{Level, LogManager}
    import org.apache.logging.log4j.core.config.Configurator
    import scala.collection.JavaConverters._

    // Ensure log4j2.xml is loaded when Play invokes this overload directly.
    configure(env)

    // Read every key under `logger` in application.conf and apply to log4j2.
    // e.g. logger.root = INFO  ->  sets root logger to INFO
    //      logger.play = WARN  ->  sets "play" logger to WARN
    Try(configuration.underlying.getConfig("logger")).toOption.foreach { loggerConf =>
      loggerConf.entrySet().asScala.foreach { entry =>
        val name      = entry.getKey
        val levelStr  = entry.getValue.unwrapped().toString
        val level     = Level.toLevel(levelStr.toUpperCase, Level.INFO)
        val logName   = if (name == "root") LogManager.ROOT_LOGGER_NAME else name
        Configurator.setLevel(logName, level)
      }
    }
  }

  def configure(properties: Map[String, String], config: Option[java.net.URL]): Unit = ()
  def loggerFactory: org.slf4j.ILoggerFactory = org.slf4j.LoggerFactory.getILoggerFactory
  def shutdown(): Unit = ()
  def stop(): Unit = ()
}
