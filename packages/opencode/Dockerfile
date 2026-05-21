FROM ubuntu:24.04

ARG BUN_RUNTIME_TRANSPILER_CACHE_PATH=0
ENV BUN_RUNTIME_TRANSPILER_CACHE_PATH=${BUN_RUNTIME_TRANSPILER_CACHE_PATH}

# Full set of common Linux tools + sandbox dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash sudo curl wget ca-certificates \
    vim nano git jq \
    net-tools iputils-ping dnsutils traceroute \
    whois netcat-openbsd telnet \
    ripgrep bubblewrap socat \
    && rm -rf /var/lib/apt/lists/* \
    && userdel -r ubuntu 2>/dev/null || true

COPY dist/opencode-linux-x64/bin/opencode /usr/local/bin/opencode

# Pre-populate Global.Path.bin (~/.cache/opencode/bin) with ripgrep so the
# server never tries to download it at runtime. Without this, the first startup
# may spend time downloading the binary.
RUN mkdir -p /root/.cache/opencode/bin \
    && ln -s /usr/bin/rg /root/.cache/opencode/bin/rg

# Install zerobox from GitHub releases so the binary lives outside /root,
# enabling --deny-read /root inside the sandbox for full home-directory isolation.
#
# NOTE: 启动容器时必须加 --security-opt seccomp=unconfined，否则容器内 user namespace
# 被禁用，zerobox 会退回 legacy-landlock 模式，与 system-read-linux profile 不兼容而 panic。
# 示例：docker run --security-opt seccomp=unconfined -p 4096:4096 opencode:dev
COPY dist/zerobox /usr/local/bin/zerobox
RUN chmod +x /usr/local/bin/zerobox
ENV ZEROBOX_BIN=/usr/local/bin/zerobox
ENV OPENCODE_SANDBOX=true
ENV OPENCODE_DISABLE_AUTOUPDATE=true
ENV OPENCODE_DISABLE_MODELS_FETCH=true
ENV OPENCODE_DISABLE_LSP_DOWNLOAD=true
ENV OPENCODE_EXPERIMENTAL_HTTPAPI=true
ENV OPENCODE_DISABLE_EXTERNAL_SKILLS=true
ENV OPENCODE_ENABLE_QUESTION_TOOL=false
ENV OPENCODE_ENABLE_EXA=true
ENV TZ=Asia/Shanghai

EXPOSE 4096
ENTRYPOINT ["opencode", "serve", "--hostname=0.0.0.0", "--port=4096"]
