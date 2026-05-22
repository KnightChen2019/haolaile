const app = getApp();

Page({
  data: {
    monitor: {},
    scheduleRows: [],
    windowDays: "-",
    emptyScheduleText: "正在读取排班数据...",
    subscribeTemplateIds: [],
    subscribeLoading: false,
    subscribeButtonText: "订阅有号提醒",
    subscribeHint: "授权后，发现可约号源时会通过微信服务通知提醒你。"
  },

  onLoad(query) {
    wx.showShareMenu({
      withShareTicket: false,
      menus: ["shareAppMessage"]
    });
    this.loadConfig();
    this.loadMonitor(query.id);
    this.loadSubscribeStatus();
  },

  onShareAppMessage() {
    return {
      title: this.data.monitor.doctorName ? `${this.data.monitor.doctorName}号源监控` : "号源监控",
      path: "/pages/index/index"
    };
  },

  loadConfig() {
    wx.request({
      url: `${app.globalData.apiBaseUrl}/api/config`,
      method: "GET",
      success: (res) => {
        const ids = (res.data && res.data.subscribeTemplateIds) || [];
        this.setData({
          subscribeTemplateIds: ids,
          subscribeHint: ids.length
            ? this.data.subscribeHint
            : "提醒功能暂未启用，请稍后再试。"
        });
      },
      fail: () => {
        this.setData({
          subscribeHint: "无法连接后端服务，请检查网络或服务器状态。"
        });
      }
    });
  },

  loadMonitor(id) {
    wx.request({
      url: `${app.globalData.apiBaseUrl}/api/monitors`,
      method: "GET",
      success: (res) => {
        const payload = res.data || {};
        const monitors = payload.monitors || [];
        const monitor = monitors.find((item) => item.id === id) || {};
        const scheduleRows = (monitor.slots || []).map((slot) => {
          const statusClass = slot.available
            ? "schedule-available"
            : slot.availableStatus === "3"
              ? "schedule-stopped"
              : slot.availableStatus === "4"
                ? "schedule-expired"
                : "schedule-full";
          return {
            ...slot,
            statusClass
          };
        });
        const emptyScheduleText = monitor.lastCheckedAt
          ? "最近一次查询未返回排班数据，后端会继续自动轮询。"
          : "还没有查询结果，请稍后刷新。";
        this.setData({
          monitor,
          scheduleRows,
          emptyScheduleText,
          windowDays: payload.windowDays || "-"
        });
      }
    });
  },

  loadSubscribeStatus() {
    wx.login({
      success: (loginRes) => {
        if (!loginRes.code) {
          return;
        }

        wx.request({
          url: `${app.globalData.apiBaseUrl}/api/subscribe/status`,
          method: "POST",
          header: {
            "Content-Type": "application/json"
          },
          data: {
            code: loginRes.code
          },
          success: (res) => {
            if (res.statusCode === 200 && res.data && res.data.registered) {
              this.setData({
                subscribeButtonText: "继续授权提醒",
                subscribeHint: `已登记为通知成员；当前通知成员 ${res.data.notifyOpenidCount || 1} 人。订阅授权按次消耗，需要时可继续授权。`
              });
            }
          }
        });
      }
    });
  },

  subscribeForAlerts() {
    const tmplIds = this.data.subscribeTemplateIds.slice(0, 3);
    if (!tmplIds.length) {
      wx.showToast({ title: "未配置模板", icon: "none" });
      return;
    }

    this.setData({ subscribeLoading: true, subscribeButtonText: "处理中…" });

    wx.requestSubscribeMessage({
      tmplIds,
      success: (subscribeRes) => {
        const acceptedTemplateIds = tmplIds.filter((id) => subscribeRes[id] === "accept");
        if (!acceptedTemplateIds.length) {
          this.setData({
            subscribeLoading: false,
            subscribeButtonText: "订阅有号提醒",
            subscribeHint: "你没有接受订阅授权，暂时无法发送微信提醒。"
          });
          wx.showToast({ title: "未授权订阅", icon: "none" });
          return;
        }

        wx.login({
          success: (loginRes) => {
            if (!loginRes.code) {
                this.setData({
                  subscribeLoading: false,
                  subscribeButtonText: "订阅有号提醒",
                  subscribeHint: "微信登录失败，请稍后重试。"
                });
                return;
            }

            wx.request({
              url: `${app.globalData.apiBaseUrl}/api/subscribe/register`,
              method: "POST",
              header: {
                "Content-Type": "application/json"
              },
              data: {
                code: loginRes.code,
                acceptedTemplateIds
              },
              success: (regRes) => {
                if (regRes.statusCode === 200 && regRes.data && regRes.data.ok) {
                  this.setData({
                    subscribeLoading: false,
                    subscribeButtonText: "继续授权提醒",
                    subscribeHint: `已登记为通知成员；当前通知成员 ${regRes.data.notifyOpenidCount || 1} 人。订阅授权按次消耗，需要时可继续授权。`
                  });
                  wx.showToast({ title: "已登记", icon: "success" });
                } else {
                  const msg =
                    (regRes.data && (regRes.data.message || regRes.data.errmsg)) || "登记失败";
                  this.setData({
                    subscribeLoading: false,
                    subscribeButtonText: "订阅有号提醒",
                    subscribeHint: msg
                  });
                  wx.showToast({ title: msg, icon: "none" });
                }
              },
              fail: () => {
                this.setData({
                  subscribeLoading: false,
                  subscribeButtonText: "订阅有号提醒",
                  subscribeHint: "无法连接后端服务"
                });
                wx.showToast({ title: "网络错误", icon: "none" });
              }
            });
          },
          fail: () => {
            this.setData({
              subscribeLoading: false,
              subscribeButtonText: "订阅有号提醒",
              subscribeHint: "微信登录失败，请稍后重试。"
            });
          }
        });
      },
      fail: () => {
        this.setData({
          subscribeLoading: false,
          subscribeButtonText: "订阅有号提醒",
          subscribeHint: "订阅授权弹窗调用失败。"
        });
      }
    });
  }
});
