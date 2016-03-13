import http from 'http'
import { parse as parseURL } from 'url'
import { join as joinPaths } from 'path'
import { stat as statFile, readFile } from 'fs'
import tmpdir from 'os-tmpdir'
import { maxSatisfying as maxSatisfyingVersion } from 'semver'
import createBowerPackage from './createBowerPackage'
import getPackageInfo from './getPackageInfo'
import getPackage from './getPackage'
import {
  sendNotFoundError,
  sendInvalidURLError,
  sendServerError,
  sendRedirect,
  sendFile
} from './ResponseUtils'

const TmpDir = tmpdir()
const URLFormat = /^\/((?:@[^\/@]+\/)?[^\/@]+)(?:@([^\/]+))?(\/.+)?$/

const decodeParam = (param) =>
  param && decodeURIComponent(param)

const parsePackageURL = (pathname) => {
  const url = parseURL(pathname)
  const match = URLFormat.exec(url.pathname)

  if (match == null)
    return null

  const packageName = match[1]
  const version = decodeParam(match[2]) || 'latest'
  const filename = decodeParam(match[3])
  const { search } = parseURL(pathname)

  return {           // If the URL is /@scope/name@version/path.js?bundle:
    packageName,     // @scope/name
    version,         // version
    filename,        // /path.js
    search           // ?bundle
  }
}

const createPackageURL = (packageName, version, filename, search) => {
  let pathname = `/${packageName}`

  if (version != null)
    pathname += `@${version}`

  if (filename != null)
    pathname += filename

  if (search)
    pathname += search

  return pathname
}

const OneMinute = 60
const OneDay = OneMinute * 60 * 24
const OneYear = OneDay * 365

const isVersionNumber = (version) =>
  (/^\d/).test(version)

const getMaxAge = (packageVersion) =>
  isVersionNumber(packageVersion) ? OneYear : OneMinute

const checkLocalCache = (dir, callback) =>
  statFile(joinPaths(dir, 'package.json'), (error, stats) => {
    callback(stats && stats.isFile())
  })

const ResolveExtensions = [ '', '.js', '.json' ]

/**
 * Resolves a path like "lib/index" into "lib/index.js" or
 * "lib/index.json" depending on which one is available, similar
 * to how require('lib/index') does.
 */
const resolveFile = (file, autoIndex, callback) => {
  ResolveExtensions.reduceRight((next, ext) => {
    const filename = file + ext

    return () => {
      statFile(filename, (error, stats) => {
        if (stats && stats.isFile()) {
          callback(null, filename)
        } else if (autoIndex && stats && stats.isDirectory()) {
          resolveFile(joinPaths(filename, 'index'), false, (error, indexFile) => {
            if (error) {
              callback(error)
            } else if (indexFile) {
              callback(null, indexFile)
            } else {
              next()
            }
          })
        } else if (error && error.code !== 'ENOENT') {
          callback(error)
        } else {
          next()
        }
      })
    }
  }, callback)()
}

/**
 * Creates and returns a function that can be used in the "request"
 * event of a standard node HTTP server. Options are:
 *
 * - registryURL    The URL of the npm registry (optional, defaults to https://registry.npmjs.org)
 * - bowerBundle    A special pathname that is used to create and serve zip files required by Bower
 *                  (optional, defaults to "/bower.zip")
 *
 * Supported URL schemes are:
 *
 * /history@1.12.5/umd/History.min.js (recommended)
 * /history@1.12.5 (package.json's main is implied)
 *
 * Additionally, the following URLs are supported but will return a
 * temporary (302) redirect:
 *
 * /history (redirects to version, latest is implied)
 * /history/umd/History.min.js (redirects to version, latest is implied)
 * /history@latest/umd/History.min.js (redirects to version)
 * /history@^1/umd/History.min.js (redirects to max satisfying version)
 */
export const createRequestHandler = (options = {}) => {
  const registryURL = options.registryURL || 'https://registry.npmjs.org'
  const bowerBundle = options.bowerBundle || '/bower.zip'

  return function handleRequest(req, res) {
    const url = parsePackageURL(req.url)

    if (url == null)
      return sendInvalidURLError(res, req.url)

    const { packageName, version, filename, search } = url
    const tarballDir = joinPaths(TmpDir, packageName + '-' + version)

    function tryToFinish() {
      if (filename === bowerBundle) {
        createBowerPackage(tarballDir, function (error, file) {
          if (error) {
            sendServerError(res, error)
          } else if (file == null) {
            sendNotFoundError(res, `bower.zip in package ${packageName}@${version}`)
          } else {
            sendFile(res, file, getMaxAge(version))
          }
        })
      } else if (filename) {
        resolveFile(joinPaths(tarballDir, filename), false, (error, file) => {
          if (error) {
            sendServerError(res, error)
          } else if (file == null) {
            sendNotFoundError(res, `file "${filename}" in package ${packageName}@${version}`)
          } else {
            sendFile(res, file, getMaxAge(version))
          }
        })
      } else {
        readFile(joinPaths(tarballDir, 'package.json'), 'utf8', (error, data) => {
          if (error)
            return sendServerError(res, error)

          // Default main is index, same as npm
          const packageConfig = JSON.parse(data)
          const mainProperty = (req.query && req.query.main) || 'main'
          const mainFilename = packageConfig[mainProperty] || 'index'

          resolveFile(joinPaths(tarballDir, mainFilename), true, (error, file) => {
            if (error) {
              sendServerError(res, error)
            } else if (file == null) {
              sendNotFoundError(res, `main file "${mainFilename}" in package ${packageName}@${version}`)
            } else {
              sendFile(res, file, getMaxAge(version))
            }
          })
        })
      }
    }

    checkLocalCache(tarballDir, (isCached) => {
      if (isCached)
        return tryToFinish() // Best case: we already have this package on disk.

      // Fetch package info from NPM registry.
      getPackageInfo(registryURL, packageName, function (error, response) {
        if (error)
          return sendServerError(res, error)

        if (response.status === 404)
          return sendNotFoundError(res, `package "${packageName}"`)

        const info = response.jsonData

        if (info == null || info.versions == null)
          return sendServerError(res, new Error(`Unable to retrieve info for package ${packageName}`))

        const { versions, 'dist-tags': tags } = info

        if (version in versions) {
          // A valid request for a package we haven't downloaded yet.
          const packageConfig = versions[version]
          const tarballURL = parseURL(packageConfig.dist.tarball)

          getPackage(tarballURL, tarballDir, function (error) {
            if (error) {
              sendServerError(res, error)
            } else {
              tryToFinish()
            }
          })
        } else if (version in tags) {
          sendRedirect(res, createPackageURL(packageName, tags[version], filename, search))
        } else {
          const maxVersion = maxSatisfyingVersion(Object.keys(versions), version)

          if (maxVersion) {
            sendRedirect(res, createPackageURL(packageName, maxVersion, filename, search))
          } else {
            sendNotFoundError(res, `package ${packageName}@${version}`)
          }
        }
      })
    })
  }

  return handleRequest
}

/**
 * Creates and returns an HTTP server that serves files
 * from NPM packages.
 */
export const createServer = (options) =>
  http.createServer(
    createRequestHandler(options)
  )
