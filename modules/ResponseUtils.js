import mime from 'mime'
import { createReadStream } from 'fs'

export function sendHTML(res, html) {
  res.type('text/html').end(html)
}

export function sendText(res, text) {
  res.type('text/plain').end(text)
}

export function sendInvalidURLError(res, url) {
  sendText(res.status(403), `Invalid URL: ${url}`)
}

export function sendNotFoundError(res, what) {
  sendText(res.status(404), `Not found: ${what}`)
}

export function sendServerError(res, error) {
  sendText(res.status(500), `Server error: ${error.message}`)
}

export function sendFile(res, file, maxAge=0) {
  const fileStream = createReadStream(file)

  fileStream.on('error', function (error) {
    sendServerError(res, error)
  })

  res.set({
    'Content-Type': `${mime.lookup(file)}; charset=utf-8`,
    'Cache-Control': `public, max-age=${maxAge}`
  })

  fileStream.pipe(res)
}

export function sendRedirect(res, location, status=302) {
  sendHTML(
    res.status(status).set('Location', location),
    `<p>You are being redirected to <a href="${location}">${location}</a>`
  )
}
