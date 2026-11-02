FROM node:22-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da AS node_runtime
FROM ubuntu:24.04@sha256:24737cef17f4e22b1977df7d9a05e77c4e28b7da5b8911f8d8ccda136bf3573c
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends systemd systemd-sysv postgresql postgresql-client openssh-server ca-certificates curl git iproute2 util-linux sudo && rm -rf /var/lib/apt/lists/*
COPY --from=node_runtime /usr/local/ /usr/local/
COPY wsl.conf /etc/wsl.conf
RUN systemctl enable postgresql ssh && mkdir -p /run/sshd
CMD ["/sbin/init"]
