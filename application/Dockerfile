FROM spaneng/doover_device_base AS base_image

## FIRST STAGE ##
FROM base_image AS builder

# Install pipenv requirements
RUN apt update && apt install -y git
RUN pip install pipenv --no-cache-dir
COPY Pipfile .
COPY Pipfile.lock .
RUN PIP_USER=1 PIP_IGNORE_INSTALLED=1 pipenv install --system --deploy --ignore-pipfile --clear


## SECOND STAGE ##
FROM base_image AS final_image

COPY --from=builder $PYROOT/lib/ $PYROOT/lib/

WORKDIR /
COPY . /app

WORKDIR /app

ENTRYPOINT ["python", "-u", "application.py"]