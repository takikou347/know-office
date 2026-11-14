# ワークスペースのイメージ。know-office の全体を置き場にして作る (社員が考えるの 3.1)
# Node 22.23.5。版は digest で固定する
FROM node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee

# 社員は root でない staff で動く。Debian の staff の組は /usr/local に書ける事があるので、組は別の office にする
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ripgrep ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g pnpm@10.28.0 \
  && groupadd --gid 10001 office \
  && useradd --create-home --shell /bin/bash --uid 10001 --gid office staff

# ワークスペースのコードとフックは /opt/workspace に置き、root の持ち物で社員が書けなくする
WORKDIR /opt/workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/
COPY apps/workspace/package.json apps/workspace/
COPY apps/office/package.json apps/office/
RUN pnpm install --frozen-lockfile --prod --ignore-scripts --filter @know-office/workspace...
COPY packages/core/src packages/core/src
COPY apps/workspace/src apps/workspace/src
RUN chown -R root:root /opt/workspace && chmod -R go-w /opt/workspace

# 社員が書けるのはタスクのリポジトリを置く /work だけ
RUN mkdir /work && chown staff:office /work

USER staff
WORKDIR /work
# Containers が外向きの HTTPS を受け手に回すための CA を信じる
ENV NODE_EXTRA_CA_CERTS=/etc/cloudflare/certs/cloudflare-containers-ca.crt
EXPOSE 8080
CMD ["node", "--experimental-strip-types", "--disable-warning=ExperimentalWarning", "/opt/workspace/apps/workspace/src/main.ts"]
