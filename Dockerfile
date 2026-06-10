FROM spaneng/doover_device_base AS base_image

## FIRST STAGE ##
FROM base_image AS builder

COPY --from=ghcr.io/astral-sh/uv:0.7.3 /uv /uvx /bin/
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy
ENV UV_PYTHON_DOWNLOADS=0

WORKDIR /app

RUN uv venv --system-site-packages

RUN --mount=type=cache,target=/root/.cache/uv \
    --mount=type=bind,source=uv.lock,target=uv.lock \
    --mount=type=bind,source=pyproject.toml,target=pyproject.toml \
    SKIP=$(uv pip freeze --system | sed -E 's/[[:space:]@=].*//; s/^/--no-install-package /' | tr '\n' ' ') && \
    uv sync --locked --no-install-project --no-dev $SKIP

COPY . /app
RUN --mount=type=cache,target=/root/.cache/uv \
    SKIP=$(uv pip freeze --system | sed -E 's/[[:space:]@=].*//; s/^/--no-install-package /' | tr '\n' ' ') && \
    uv sync --locked --no-dev $SKIP


## SECOND STAGE ##
FROM base_image AS final_image

COPY --from=builder --chown=app:app /app /app
ENV PATH="/app/.venv/bin:$PATH"
CMD ["doover-app-run"]
