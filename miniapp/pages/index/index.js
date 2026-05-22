const app = getApp();
const AUTO_REFRESH_INTERVAL_MS = 10000;

function formatTime(value) {
  if (!value) return "未检查";
  const date = new Date(value);
  const pad = (number) => String(number).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

Page({
  data: {
    loading: true,
    error: "",
    systemStatus: "连接中",
    windowDays: "-",
    enabledCount: 0,
    lastCheckedText: "-",
    monitors: []
  },
  autoRefreshTimer: null,

  onLoad() {
    wx.showShareMenu({
      withShareTicket: false,
      menus: ["shareAppMessage"]
    });
    this.loadMonitors();
  },

  onShow() {
    this.startAutoRefresh();
  },

  onHide() {
    this.stopAutoRefresh();
  },

  onUnload() {
    this.stopAutoRefresh();
  },

  onShareAppMessage() {
    return {
      title: "号来了",
      path: "/pages/index/index"
    };
  },

  loadMonitors(options = {}) {
    if (!options.silent) {
      this.setData({ loading: true, error: "", systemStatus: "连接中" });
    }

    wx.request({
      url: `${app.globalData.apiBaseUrl}/api/monitors`,
      method: "GET",
      success: (res) => {
        const payload = res.data || {};
        const monitors = (payload.monitors || []).map((item) => ({
          ...item,
          statusText: item.hasAvailability ? "发现有号" : item.enabled ? "监控中" : "已暂停",
          statusClass: item.hasAvailability ? "status-found" : item.enabled ? "status-ok" : "status-paused",
          lastCheckedAtText: formatTime(item.lastCheckedAt)
        }));
        const lastCheckedAt = monitors
          .map((item) => item.lastCheckedAt)
          .filter(Boolean)
          .sort()
          .pop();

        this.setData({
          loading: false,
          systemStatus: "正常",
          monitors,
          windowDays: payload.windowDays || "-",
          enabledCount: monitors.filter((item) => item.enabled).length,
          lastCheckedText: formatTime(lastCheckedAt)
        });
      },
      fail: () => {
        this.setData({
          loading: false,
          systemStatus: "离线",
          error: "无法连接后端服务，请检查网络或服务器状态"
        });
      }
    });
  },

  startAutoRefresh() {
    this.stopAutoRefresh();
    this.autoRefreshTimer = setInterval(() => {
      this.loadMonitors({ silent: true });
    }, AUTO_REFRESH_INTERVAL_MS);
  },

  stopAutoRefresh() {
    if (this.autoRefreshTimer) {
      clearInterval(this.autoRefreshTimer);
      this.autoRefreshTimer = null;
    }
  },

  openDetail(event) {
    const id = event.currentTarget.dataset.id;
    wx.navigateTo({ url: `/pages/detail/detail?id=${id}` });
  },

  goSettings() {
    wx.navigateTo({ url: "/pages/settings/settings" });
  }
});
