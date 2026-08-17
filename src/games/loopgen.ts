/**
 * 时间循环程序化生成(方案五 M3,docs/05-time-loop.md §7.2)。
 *
 * v1 落地:三本手工骨架(钟楼倒塌/客栈大火/宴会中毒)× 两套叙事皮肤(武侠/西幻)
 * = 结构不变、名字与叙事换皮的变体;每个变体都必须通过 ScheduleSolver(solveLoop)
 * 硬门禁才会进入剧本池。生成纯函数、种子确定性。
 */

import type { LoopScript } from './loop.js'
import { NORTH_BRIDGE, INN_FIRE, BANQUET_POISON } from './loop.js'

interface LoopSkin {
  id: string
  suffix: string
  /** 默认显示词 → 皮肤显示词(最长优先替换,自动覆盖全部叙事文本与匹配关键词)。 */
  names: Record<string, string>
}

const SKINS: LoopSkin[] = [
  {
    id: 'classic',
    suffix: '',
    names: {},
  },
  {
    id: 'wuxia',
    suffix: '·武侠',
    names: {
      北桥镇: '北桥山庄',
      雾水镇: '雾水庄',
      顾府: '顾庄',
      镇长: '庄主',
      邮差: '镖师',
      记者: '捕头',
      卫兵: '捕快',
      老宅: '山庄',
      钟楼: '鼓楼',
      图书馆: '藏经楼',
      镇公所大厅: '山庄正厅',
      集市广场: '市集',
      镇公所: '正厅',
      集市: '市集',
      塔底: '楼底',
      客栈: '旅店',
      来福客栈: '来福旅店',
      钱掌柜: '钱庄主',
      巡捕: '衙役',
      班头: '捕头',
      药铺: '医馆',
      药铺老板: '医馆馆主',
      管家: '总管',
      厨娘: '庖厨',
      洋钟: '西洋钟',
      西洋钟: '西洋钟',
      宴会厅: '宴客厅',
      厨房: '伙房',
      花园: '后花园',
      书房: '书斋',
      卧室: '厢房',
      密室: '暗室',
      阁楼: '阁楼',
      湖: '湖',
      桥: '桥',
    },
  },
  {
    id: 'western',
    suffix: '·西幻',
    names: {
      北桥镇: '北桥城',
      雾水镇: '雾水城',
      顾府: '顾宅',
      镇长: '城主',
      邮差: '信使',
      记者: '游吟诗人',
      卫兵: '城卫',
      老宅: '城堡',
      钟楼: '钟塔',
      图书馆: '书库',
      镇公所大厅: '市政厅',
      集市广场: '市集广场',
      镇公所: '市政厅',
      集市: '市集',
      塔底: '塔底',
      客栈: '旅店',
      来福客栈: '来福旅店',
      钱掌柜: '钱老板',
      巡捕: '巡逻卫',
      班头: '卫队长',
      药铺: '药剂铺',
      药铺老板: '药剂师',
      管家: '执事',
      厨娘: '厨娘',
      宴会厅: '宴会大厅',
      厨房: '厨房',
      花园: '庭园',
      书房: '书房',
      卧室: '卧房',
      密室: '密室',
      阁楼: '阁楼',
    },
  },
]

/** 骨架库(惰性访问,避免与 loop.js 的循环导入在模块求值期触发 TDZ)。 */
function bases(): LoopScript[] {
  return [NORTH_BRIDGE, INN_FIRE, BANQUET_POISON]
}

/** 程序化变体:骨架 × 皮肤(种子确定性;经典皮肤即原版,不重复生成)。 */
export function generateLoopScript(seed: number): LoopScript {
  const pool = bases()
  const base = pool[Math.abs(seed) % pool.length]
  const skin = SKINS[1 + (Math.floor(Math.abs(seed) / pool.length) % (SKINS.length - 1))]
  const pairs = Object.entries(skin.names).sort((a, b) => b[0].length - a[0].length)
  const repl = (text: string): string => {
    let out = text
    for (const [from, to] of pairs) out = out.split(from).join(to)
    return out
  }
  const clone: LoopScript = JSON.parse(JSON.stringify(base)) as LoopScript
  clone.id = `${base.id}-${skin.id}`
  clone.title = `${base.title}${skin.suffix}`
  clone.intro = repl(base.intro)
  clone.locations = clone.locations.map((l) => ({ ...l, name: repl(l.name), desc: repl(l.desc) }))
  clone.npcs = clone.npcs.map((n) => ({
    ...n,
    name: repl(n.name),
    role: repl(n.role),
    bio: repl(n.bio),
    schedule: n.schedule.map((s) => ({ ...s, action: repl(s.action) })),
  }))
  clone.facts = clone.facts.map((f) => ({ ...f, text: repl(f.text), auditKeywords: (f.auditKeywords ?? []).map(repl) }))
  clone.npc = Object.fromEntries(
    Object.entries(clone.npc).map(([id, npc]) => [id, { ...npc, persona: repl(npc.persona), liePolicy: repl(npc.liePolicy), knowledge: npc.knowledge, mustNotAdmit: npc.mustNotAdmit }]),
  )
  clone.events = clone.events.map((e) => ({
    ...e,
    name: repl(e.name),
    observe: repl(e.observe),
    investigate: e.investigate !== undefined ? { ...e.investigate, target: repl(e.investigate.target), text: repl(e.investigate.text) } : undefined,
  }))
  clone.actions = clone.actions.map((a) => ({
    ...a,
    name: repl(a.name),
    keywords: a.keywords.map(repl),
    effect: { ...a.effect, text: repl(a.effect.text) },
  }))
  clone.items = clone.items.map((i) => ({ ...i, name: repl(i.name), desc: repl(i.desc) }))
  clone.tragedy = { ...clone.tragedy, name: repl(clone.tragedy.name), collapseText: repl(clone.tragedy.collapseText), lockedText: repl(clone.tragedy.lockedText) }
  clone.edgeNotes = Object.fromEntries(Object.entries(clone.edgeNotes).map(([k, v]) => [k, repl(v)]))
  clone.winPath = clone.winPath.map(repl)
  clone.causalEdges = clone.causalEdges.map((e) => ({ ...e, note: repl(e.note) }))
  clone.hints = clone.hints.map(repl) as [string, string, string]
  return clone
}
