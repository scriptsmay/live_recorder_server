const fs = require('fs');
const path = require('path');

const styleCss = fs.readFileSync(path.join(__dirname, '../frontend/src/style.css'), 'utf8');

// 抽出某个自定义 utility 类的规则体（形如 `  .name {` … `  }`，含缩进的顶层规则）
function utilityRuleBody(name) {
  const match = styleCss.match(new RegExp(`\\n\\s*\\.${name}\\s*\\{([\\s\\S]*?)\\n\\s*\\}`));
  if (!match) throw new Error(`style.css 中未找到 .${name} 规则`);
  return match[1];
}

describe('前端自定义 utility 与 Tailwind 变体类的层叠安全', () => {
  test('.hairline-card 不得声明 position（否则覆盖变体类如 xl:sticky）', () => {
    // 回归背景：`.hairline-card { position: relative }` 在 @layer utilities 中排在
    // Tailwind 生成的 `@media(xl){ .xl\:sticky{position:sticky} }` 之后，同为单类
    // 选择器（优先级相同），后者被静默覆盖，导致侧栏卡片上的 `top-20` 从「吸附偏移」
    // 退化为「相对自身下移 80px」。需要定位上下文的调用处应自加 `relative`（见 StatCard.vue）。
    expect(utilityRuleBody('hairline-card')).not.toMatch(/position\s*:/);
  });

  test('.hairline-card 的调用处若依赖定位上下文，须自显式声明 relative', () => {
    // ActivityTimeline 的列表折叠动画用到 `.activity-list-leave-active{position:absolute}`，
    // 该绝对定位元素需要显式 relative 容器；StatCard 的装饰光斑（absolute）同理。
    const timeline = fs.readFileSync(path.join(__dirname, '../frontend/src/components/ActivityTimeline.vue'), 'utf8');
    const statCard = fs.readFileSync(path.join(__dirname, '../frontend/src/components/ui/StatCard.vue'), 'utf8');

    expect(timeline).toMatch(/class="relative hairline-card/);
    expect(statCard).toMatch(/group relative block[^"]*hairline-card/);
  });
});
