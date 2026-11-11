# A plain Ubuntu 24.04 desktop's libraries, to try the Linux packages on
# (scripts/linux-package-check.sh): no Node, no build tools. fuse3 only, no
# FUSE 2 library: the AppImage's static runtime needs only fusermount3.
FROM ubuntu:24.04

# apt retries a failed download, with a growing pause.
RUN echo 'Acquire::Retries "5";' > /etc/apt/apt.conf.d/80-retries
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates git curl xvfb xauth x11-utils fuse3 dbus dbus-x11 \
      libgtk-3-0t64 libnss3 libasound2t64 libgbm1 libxss1 libxshmfence1 \
      libnotify4 xdg-utils libsecret-1-0 libxtst6 \
    && rm -rf /var/lib/apt/lists/*
# apt lists for installing the .deb with its dependencies later.
RUN apt-get update

COPY install.sh /check/install.sh
COPY scripts/linux-package-check-run.sh /check/run.sh
COPY scripts/linux-package-check-window.sh /check/window.sh
CMD ["bash", "/check/run.sh"]
