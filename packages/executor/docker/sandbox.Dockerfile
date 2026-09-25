# Sandbox del executor: Ubuntu con tooling para ejecutar código del agente.
# Imagen liviana: ubuntu 24.04 + node + python3 + utilidades.
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# Node 22 LTS + python3 + utilidades base del sandbox.
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates gnupg \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends \
    nodejs \
    python3 \
    python3-pip \
    build-essential \
    jq \
    file \
    findutils \
    grep \
    gawk \
    sed \
    diffutils \
    tar \
    gzip \
    unzip \
    zip \
    git \
    sqlite3 \
    bc \
    time \
    wget \
    iputils-ping \
    dnsutils \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Usuario no privilegiado. Ubuntu 24.04 ya trae 'ubuntu' con uid/gid 1000,
# que coincide con el uid del host, así los archivos del volume quedan
# legibles/escribibles desde ambos lados.
RUN mkdir -p /workspace && chown ubuntu:ubuntu /workspace

# Wrapper de shell seguro para la tool `shell` del agente:
# ejecuta el script con sh dentro del sandbox (nunca en el host).
# El executor valida el script ANTES de llegar acá (denylist).
RUN printf '#!/bin/sh\nexec /bin/sh -c "$1"\n' > /usr/local/bin/sandbox-shell \
    && chmod 755 /usr/local/bin/sandbox-shell

WORKDIR /workspace

USER ubuntu

# El executor inyecta el comando; no hay proceso default.
CMD ["sleep", "infinity"]