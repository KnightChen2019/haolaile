const app = getApp();

Page({
  data: {
    notifyOpenidCountText: "读取中"
  },

  onLoad() {
    wx.showShareMenu({
      withShareTicket: false,
      menus: ["shareAppMessage"]
    });
    this.loadNotifyStatus();
  },

  onShareAppMessage() {
    return {
      title: "号来了设置",
      path: "/pages/index/index"
    };
  },

  loadNotifyStatus() {
    wx.request({
      url: `${app.globalData.apiBaseUrl}/api/health`,
      method: "GET",
      success: (res) => {
        const count = res.data && typeof res.data.notifyOpenidCount === "number"
          ? res.data.notifyOpenidCount
          : null;
        this.setData({
          notifyOpenidCountText: count === null ? "暂时无法读取" : `${count} 人`
        });
      },
      fail: () => {
        this.setData({ notifyOpenidCountText: "暂时无法读取" });
      }
    });
  }
});
