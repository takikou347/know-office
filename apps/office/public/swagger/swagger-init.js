// ゲートウェイの Swagger UI。読むだけにし、ここから API を呼ばない
window.ui = SwaggerUIBundle({
  url: "/api/v1/openapi.yaml",
  dom_id: "#swagger",
  deepLinking: true,
  docExpansion: "none",
  supportedSubmitMethods: [],
  // 既定では外の検証サービスに文書の URL を送るので切る
  validatorUrl: null,
});
