// ゲートウェイとワークスペースが共に使う、ワークスペースのコンテナの決まった値 (社員が考えるの 3.1)

/** Cloudflare の Containers がコンテナに入れる CA。外向きの HTTPS をゲートウェイの受け手に回すため、ワークスペースの Node はこれを信じる */
export const CONTAINER_CA = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";
