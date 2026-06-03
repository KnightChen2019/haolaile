function resolveApiBaseUrl() {
  // 开发版(开发者工具)走本地后端，方便联调；体验版/正式版走云端域名。
  try {
    if (wx.getAccountInfoSync().miniProgram.envVersion === "develop") {
      return "http://127.0.0.1:3000";
    }
  } catch (e) {}
  return "https://mini-p.caicaiai.cn";
}

App({
  globalData: {
    apiBaseUrl: resolveApiBaseUrl()
  }
});
