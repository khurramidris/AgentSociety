"""
FastAPI backend service for AgentSociety 2 and the Allegory observer.

The existing research/extension routes remain intact. Allegory adds read-only
snapshot and Server-Sent Events endpoints over persisted simulation state.
"""

from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from agentsociety2 import __version__
from agentsociety2.backend.routers import (
    agent_skills,
    allegory,
    custom,
    experiments,
    modules,
    prefill_params,
    replay,
)

_project_root = Path(__file__).resolve().parents[2]
load_dotenv(_project_root / ".env")


def _setup_logging():
    """Configure backend logging from ``BACKEND_LOG_LEVEL``."""

    log_level = os.getenv("BACKEND_LOG_LEVEL", "info")
    python_log_level = "DEBUG" if log_level.lower() == "trace" else log_level.upper()
    level = getattr(logging, python_log_level, logging.INFO)

    root_logger = logging.getLogger()
    if not root_logger.handlers:
        logging.basicConfig(
            level=level,
            format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
            datefmt="%Y-%m-%d %H:%M:%S",
            force=True,
        )
    else:
        root_logger.setLevel(level)

    agentsociety_logger = logging.getLogger("agentsociety2")
    agentsociety_logger.setLevel(level)
    return agentsociety_logger


_setup_logging()
from agentsociety2.logger import get_logger

logger = get_logger()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application startup and shutdown hooks."""

    logger.info("AgentSociety 2 backend service starting")
    logger.info("Project root: %s", _project_root)
    yield
    logger.info("AgentSociety 2 backend service stopping")


app = FastAPI(
    title="AgentSociety 2 Backend API",
    description="Research APIs plus read-only Allegory simulation observer APIs",
    version=__version__,
    lifespan=lifespan,
)

# Local-development default. A public Allegory deployment must configure a
# restricted origin list and put authentication/tenancy in front of this app.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(prefill_params.router)
app.include_router(experiments.router, prefix="/api/v1")
app.include_router(replay.router, prefix="/api/v1")
app.include_router(allegory.router, prefix="/api/v1")
app.include_router(custom.router)
app.include_router(modules.router)
app.include_router(agent_skills.router)


@app.get("/")
async def root():
    """Return service metadata and primary endpoint groups."""

    return {
        "service": "AgentSociety 2 Backend API",
        "version": __version__,
        "status": "running",
        "endpoints": {
            "prefill_params": "/api/v1/prefill-params",
            "experiments": "/api/v1/experiments/{hypothesis_id}/{experiment_id}",
            "replay": "/api/v1/replay/{hypothesis_id}/{experiment_id}/*",
            "allegory_snapshot": "/api/v1/allegory/observer/snapshot",
            "allegory_events": "/api/v1/allegory/observer/events",
            "allegory_stream": "/api/v1/allegory/observer/stream",
            "custom": "/api/v1/custom/*",
            "modules": "/api/v1/modules/*",
            "agent_skills": "/api/v1/agent-skills/*",
        },
    }


@app.get("/health")
async def health_check():
    """Return backend health status."""

    return {"status": "healthy"}


@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    """Return a stable response for unhandled backend errors."""

    logger.error("Unhandled backend exception: %s", exc, exc_info=True)
    return JSONResponse(
        status_code=500,
        content={
            "success": False,
            "error": "Internal Server Error",
        },
    )


if __name__ == "__main__":
    import argparse

    import uvicorn

    parser = argparse.ArgumentParser(description="Start the AgentSociety 2 API")
    parser.add_argument(
        "--log-level",
        type=str,
        default=None,
        choices=["critical", "error", "warning", "info", "debug", "trace"],
        help="Set the backend log level",
    )
    args = parser.parse_args()

    host = os.getenv("BACKEND_HOST", "0.0.0.0")
    port = int(os.getenv("BACKEND_PORT", "8001"))
    log_level = args.log_level or os.getenv("BACKEND_LOG_LEVEL", "info")

    if args.log_level:
        os.environ["BACKEND_LOG_LEVEL"] = args.log_level
        _setup_logging()

    logger.info("Starting server: http://%s:%s", host, port)
    logger.info("Log level: %s", log_level)
    uvicorn.run(
        "agentsociety2.backend.app:app",
        host=host,
        port=port,
        reload=False,
        log_level=log_level,
        ws="wsproto",
    )
