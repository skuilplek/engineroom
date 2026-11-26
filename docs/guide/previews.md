# Site previews

Site previews let an account publish pages from its own folder to the network, without starting a server or opening a port of its own.

Previews are **off** until an administrator turns them on. The switch is at the bottom of the Agents tab in Admin. Nothing is published while it is off: the preview port answers `404` for every path, and a `/<username>/...` URL on the app's port is treated as an ordinary app path.

## The address

```
http://192.168.101.116:8081/hannes/<project>/<file>.html
```

The number after the host is the preview port. It is separate from the port the app uses. `<project>` is a folder in your home, usually under `Sites`.

Open `http://192.168.101.116:8081/hannes/` to see a list of that account's project folders and click into one.

A folder link without a file, such as `/hannes/<project>/`, serves that folder's `index.html`, or its `index.htm` if that is the name it uses. A path that names a folder but has no trailing slash is redirected to the version with the slash, so `./style.css` and `../` links resolve the way they do on any web server.

## Why the port is separate

The page you publish and the Engineroom app are on different origins. That is deliberate. Anything in `~/Sites` can be written by hand, by an agent, or by a page the agent fetched. If it shared an origin with the app it could call the app's API as whichever account was signed in, including an administrator. Keeping the port separate means the browser refuses those calls.

Two consequences are worth knowing:

- A page on the preview port cannot read your Engineroom session, and the app's own pages cannot read anything the preview stores.
- Type the preview address directly. The short `/hannes/<project>/<file>.html` form on the app's port redirects to the preview port, so old links keep working, but the redirect is the only thing that form does. While previews are off that form is an ordinary app path and is not redirected.

## What is published

Only files inside your project folder are served, and only over the preview port.

- Hidden files and hidden folders are never served: `.env`, `.git/config`, and `.ssh` are all refused.
- A path that climbs out of the folder is refused, and so is a symlink that points outside it.
- Server-side scripts such as `.php`, `.cgi`, and `.py` are not run and are not handed out. A preview is static files only.

A folder counts as a project only when it has an entry page: `index.html`, or `index.htm`. A folder whose entry point is `index.php` or another server-side script is not broken and is not empty, it just cannot be previewed, so opening it says *This project needs a server* and names the script rather than answering "not found". Two ways forward: run the project's own server and open it on its port, or have it build to static files in that folder as `index.html`.

Files beside such a script are still served, so a PHP project's CSS, JavaScript, and fonts load under the same URL — only the pages that have to be generated are missing.
- Only reads are allowed. A `POST` or `PUT` to the preview port is answered with `405`.

Pages are served with `Cache-Control: no-cache` and an `ETag`, so a browser revalidates on each visit and shows the edit you just made without a hard refresh.

## Turning previews on and off

Admin, then Agents, then Site previews takes effect as soon as it is saved. There is no restart: the switch is read on every request. With it off, the port answers `404` for every path and the app does not redirect to it.

The port itself is set by `ENGINEROOM_PREVIEW_LISTEN` in `/etc/engineroom/hub.env`, `0.0.0.0:8081` unless changed, and needs a hub restart:

```
ENGINEROOM_PREVIEW_LISTEN=
```

An empty value leaves the preview port unbound altogether, which is the harder version of off: nothing listens, so nothing can be reached even by mistake. A value of `127.0.0.1:8081` keeps previews on this machine only. Turning Site previews on in Admin will not open a port that was never bound.

The redirect and the preview both keep the host you typed and change only the port, so a hostname and an address work equally well.
