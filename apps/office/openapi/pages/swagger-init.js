// GitHub Pages の Swagger UI。読むだけにし、ここから API を呼ばない
window.ui = SwaggerUIBundle({
  url: "v1.yaml",
  dom_id: "#swagger-ui",
  deepLinking: true,
  docExpansion: "none",
  supportedSubmitMethods: [],
  // 既定では外の検証サービスに文書の URL を送るので切る
  validatorUrl: null,
});
