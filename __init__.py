import logging

from .nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS

WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]


def _install_no_cache_middleware():
    """
    A FastMask frontend JS kiszolgalasara no-cache headert tesz, hogy a
    bongeszo / ComfyUI Desktop (Electron) ne cache-elje be a regit.
    A szerver a fájlt a repobol olvassa, ezert igy minden szerkesztes azonnal
    ervenyesul egy egyszeru oldalletoltes utan is.
    """
    try:
        from aiohttp import web
        from server import PromptServer

        @web.middleware
        async def _no_cache_fastmask(request, handler):
            response = await handler(request)
            try:
                if request.path.startswith("/extensions/ComfyUI-FastMask"):
                    response.headers["Cache-Control"] = "no-store, must-revalidate"
            except Exception:
                pass
            return response

        app = PromptServer.instance.app
        if _no_cache_fastmask not in app.middlewares:
            app.middlewares.append(_no_cache_fastmask)
            logging.info("[FastMask] no-cache middleware telepitve a /extensions/ComfyUI-FastMask utvonalra")
    except Exception as e:
        logging.warning("[FastMask] no-cache middleware telepitese sikertelen: %s", e)


_install_no_cache_middleware()
