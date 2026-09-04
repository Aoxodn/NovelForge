(function () {
  var style = getComputedStyle(document.documentElement);
  var accent = style.getPropertyValue('--accent').trim();
  var accent2 = style.getPropertyValue('--accent2').trim();
  var ink = style.getPropertyValue('--ink').trim();
  var muted = style.getPropertyValue('--muted').trim();
  var rule = style.getPropertyValue('--rule').trim();
  var bg2 = style.getPropertyValue('--bg2').trim();

  var baseText = { color: ink, fontFamily: 'WorkSans, PingFang SC, Microsoft YaHei, sans-serif' };

  if (window.mermaid) {
    mermaid.initialize({ startOnLoad: true, theme: 'neutral', securityLevel: 'loose' });
  }

  // --- 图 1：模块 × 优先级 堆叠柱状图 ---
  var el1 = document.getElementById('chart-module-priority');
  if (el1 && window.echarts) {
    var chart1 = echarts.init(el1, null, { renderer: 'svg' });
    var modules = ['基础平台', '编辑器与章节', '导入导出', '搜索替换', '实体与人物', '时间与事件', '伏笔与大纲', '分析与版本', '性能与扩展'];
    chart1.setOption({
      animation: false,
      color: [accent, accent2, muted],
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, appendToBody: true },
      legend: {
        top: 0,
        data: ['P0 · V1.0', 'P1 · V1.5', 'P2 · V2.0'],
        textStyle: baseText
      },
      grid: { left: 8, right: 16, top: 40, bottom: 8, containLabel: true },
      xAxis: {
        type: 'category',
        data: modules,
        axisLabel: { color: ink, interval: 0, fontSize: 12.5 },
        axisLine: { lineStyle: { color: rule } },
        axisTick: { show: false }
      },
      yAxis: {
        type: 'value',
        name: '功能数',
        nameTextStyle: { color: muted },
        minInterval: 1,
        axisLabel: { color: muted },
        splitLine: { lineStyle: { color: rule } }
      },
      series: [
        {
          name: 'P0 · V1.0', type: 'bar', stack: 'total', barWidth: '52%',
          data: [3, 5, 4, 1, 2, 0, 0, 0, 1],
          label: { show: true, position: 'inside', color: '#FAF8F4', fontSize: 12 }
        },
        {
          name: 'P1 · V1.5', type: 'bar', stack: 'total',
          data: [0, 0, 0, 1, 4, 3, 4, 2, 0],
          label: { show: true, position: 'inside', color: '#FAF8F4', fontSize: 12 }
        },
        {
          name: 'P2 · V2.0', type: 'bar', stack: 'total',
          data: [0, 0, 2, 0, 1, 1, 0, 4, 2],
          label: { show: true, position: 'inside', color: '#FAF8F4', fontSize: 12 }
        }
      ]
    });
    window.addEventListener('resize', function () { chart1.resize(); });
  }

  // --- 图 2：阶段 × 难度 分组柱状图 ---
  var el2 = document.getElementById('chart-stage-difficulty');
  if (el2 && window.echarts) {
    var chart2 = echarts.init(el2, null, { renderer: 'svg' });
    var stages = ['V1.0 · 16 项', 'V1.5 · 14 项', 'V2.0 · 10 项'];
    chart2.setOption({
      animation: false,
      color: [muted, accent, accent2],
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, appendToBody: true },
      legend: {
        top: 0,
        data: ['低 · 装配', '中 · 组装调优', '高 · 自研启发式'],
        textStyle: baseText
      },
      grid: { left: 8, right: 16, top: 40, bottom: 8, containLabel: true },
      xAxis: {
        type: 'category',
        data: stages,
        axisLabel: { color: ink, fontSize: 13 },
        axisLine: { lineStyle: { color: rule } },
        axisTick: { show: false }
      },
      yAxis: {
        type: 'value',
        name: '功能数',
        nameTextStyle: { color: muted },
        minInterval: 1,
        axisLabel: { color: muted },
        splitLine: { lineStyle: { color: rule } }
      },
      series: [
        {
          name: '低 · 装配', type: 'bar', barWidth: '22%', barGap: '35%',
          data: [4, 3, 1],
          label: { show: true, position: 'top', color: muted, fontSize: 12.5 },
          itemStyle: { borderRadius: [3, 3, 0, 0] }
        },
        {
          name: '中 · 组装调优', type: 'bar',
          data: [8, 7, 5],
          label: { show: true, position: 'top', color: ink, fontSize: 12.5 },
          itemStyle: { borderRadius: [3, 3, 0, 0] }
        },
        {
          name: '高 · 自研启发式', type: 'bar',
          data: [4, 4, 4],
          label: { show: true, position: 'top', color: accent2, fontSize: 12.5, fontWeight: 'bold' },
          itemStyle: { borderRadius: [3, 3, 0, 0] }
        }
      ]
    });
    window.addEventListener('resize', function () { chart2.resize(); });
  }
})();
