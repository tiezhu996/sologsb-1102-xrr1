/**
 * 排程算法快速自测（不入构建、不依赖浏览器）：
 *   npx tsc scripts/test-scheduler.mjs 无法直接跑，故用 node --experimental 方式：
 *   直接由 vite/esbuild 转译运行（package.json 无测试框架时的轻量手段）。
 */
import { buildTurnoverPlan, planNextConfirmation } from '../src/utils/turnoverScheduler.ts';

let failures = 0;
function assert(cond, msg) {
  if (!cond) {
    failures += 1;
    console.error('✗', msg);
  } else {
    console.log('✓', msg);
  }
}

const scene = (id, seq, durationMin, needsShadowScreen = 'standard', title = id) => ({
  id,
  seq,
  title,
  durationMin,
  needsShadowScreen,
});

// 场景 1：四场标准 20′，换景 10′，容量 3 → 第四场必须顺延
// s1/s2/s3 [0,30)，s4 最早 0，挡它的是 1/2/3，放到 30
{
  const scenes = [scene('s1', 1, 20), scene('s2', 2, 20), scene('s3', 3, 20), scene('s4', 4, 20)];
  const plan = buildTurnoverPlan(scenes, [], 10);
  assert(plan.rows[0].startMin === 0 && plan.rows[0].delayMin === 0, 's1 准点 0 开台');
  assert(plan.rows[3].startMin === 30, 's4 容量不足，顺延到 30');
  assert(plan.rows[3].delayMin === 30, 's4 顺延 30 分钟');
  assert(
    [...plan.rows[3].blockedBySceneIds].sort().join() === 's1,s2,s3',
    `s4 登记被 s1/s2/s3 占着（实际：${plan.rows[3].blockedBySceneIds.join()}）`,
  );
  assert(plan.rows[3].setMin === 60, 's4 换景后 60 放台');
}

// 场景 2：双联占两台
// s1 twin [0,30) 占2，s2 standard [0,30) 占1（满），s3 twin 最早0放不下 → 30
{
  const scenes = [scene('t1', 1, 20, 'twin'), scene('u1', 2, 20, 'standard'), scene('t2', 3, 20, 'twin')];
  const plan = buildTurnoverPlan(scenes, [], 10);
  assert(plan.rows[0].slots === 2 && plan.rows[1].slots === 1, '双联 2 台、标准 1 台');
  assert(plan.rows[2].startMin === 30, `双联 t2 顺延到 30（实际 ${plan.rows[2].startMin}）`);
  assert(
    [...plan.rows[2].blockedBySceneIds].sort().join() === 't1,u1',
    `t2 被 t1/u1 占着（实际：${plan.rows[2].blockedBySceneIds.join()}）`,
  );
}

// 场景 3：缺规格的旧场次按标准影窗算
{
  const old = { id: 'old', seq: 1, title: '旧场', durationMin: 15 };
  const plan = buildTurnoverPlan([old], [], 10);
  assert(plan.rows[0].spec === 'standard' && plan.rows[0].slots === 1, '无规格旧场按标准 1 台');
}

// 场景 4：已开排锁定，改时长后未开排重算
// 先开排 s1（20′→账上锁定），再把 s1 改成 40′、s2 仍 20′：
// s1 账上区间 [0,30)，s2 [0,30) 与账不冲突（账不随改动变长），且 drift=true
{
  const scenesV1 = [scene('s1', 1, 20), scene('s2', 2, 20)];
  const entry1 = {
    id: 'e1',
    playId: 'p',
    sceneId: 's1',
    orderIndex: 1,
    screenSpec: 'standard',
    slots: 1,
    durationMin: 20,
    changeoverMin: 10,
    startMin: 0,
    endMin: 20,
    setMin: 30,
    delayMin: 0,
    blockedBySceneIds: [],
    confirmedAt: '2026-10-03T10:00:00.000Z',
    createdAt: '2026-10-03T10:00:00.000Z',
    updatedAt: '2026-10-03T10:00:00.000Z',
  };
  const scenesV2 = [scene('s1', 1, 40), scene('s2', 2, 20)];
  const plan = buildTurnoverPlan(scenesV2, [entry1], 10);
  assert(plan.rows[0].durationMin === 20, '已开排 s1 账上时长锁定为 20′');
  assert(plan.rows[0].drift === true, 's1 改时长后标记账后改过');
  assert(plan.rows[1].startMin === 0, '未开排 s2 按最新顺序仍可 0 开台（账锁定不拉长）');
  assert(plan.rows[1].drift === false, 's2 无 drift');
}

// 场景 5：顺序改动后，已开排仍按账锁定，未开排按新顺序排
// s2 先开排（账 orderIndex=2,start 0），调序后 s2 排第一、s1 第二
{
  const entry = {
    id: 'e2',
    playId: 'p',
    sceneId: 's2',
    orderIndex: 2,
    screenSpec: 'standard',
    slots: 1,
    durationMin: 20,
    changeoverMin: 10,
    startMin: 0,
    endMin: 20,
    setMin: 30,
    delayMin: 0,
    blockedBySceneIds: [],
    confirmedAt: '2026-10-03T10:01:00.000Z',
    createdAt: '2026-10-03T10:01:00.000Z',
    updatedAt: '2026-10-03T10:01:00.000Z',
  };
  const reordered = [scene('s2', 1, 20), scene('s1', 2, 20), scene('s3', 3, 20), scene('s4', 4, 20)];
  const plan = buildTurnoverPlan(reordered, [entry], 10);
  assert(plan.rows[0].confirmed && plan.rows[0].startMin === 0, '调序后 s2 仍按账锁定在 0');
  assert(plan.rows[0].orderIndex === 1, '账本条展示位序跟随新顺序');
  // s1/s2/s3 三台标准影窗恰好把 3 个台口占满，均可 0 点开台；s4 顺延到 30
  assert(plan.rows[1].startMin === 0, 's1 0 开台');
  assert(plan.rows[2].startMin === 0, 's3 0 开台（三台占满）');
  assert(plan.rows[3].startMin === 30 && plan.rows[3].delayMin === 30, 's4 顺延到 30');
  assert(
    [...plan.rows[3].blockedBySceneIds].sort().join() === 's1,s2,s3',
    `s4 被 s1/s2/s3 占着（实际：${plan.rows[3].blockedBySceneIds.join()}）`,
  );
}

// 场景 6：planNextConfirmation 总是给场序上第一条未开排
{
  const entry = {
    id: 'e3',
    playId: 'p',
    sceneId: 's1',
    orderIndex: 1,
    screenSpec: 'standard',
    slots: 1,
    durationMin: 20,
    changeoverMin: 10,
    startMin: 0,
    endMin: 20,
    setMin: 30,
    delayMin: 0,
    blockedBySceneIds: [],
    confirmedAt: '2026-10-03T10:02:00.000Z',
    createdAt: '2026-10-03T10:02:00.000Z',
    updatedAt: '2026-10-03T10:02:00.000Z',
  };
  const scenes = [scene('s1', 1, 20), scene('s2', 2, 20)];
  const next = planNextConfirmation(scenes, [entry], 10);
  assert(next?.sceneId === 's2', '接着最后确认的一场，下一场是 s2');
  assert(planNextConfirmation(scenes, [entry, { ...entry, id: 'e4', sceneId: 's2', orderIndex: 2, confirmedAt: 'x' }], 10) === null, '全部开排后返回 null');
}

// 场景 7：换景设置只影响未开排场，已开排用账上值
{
  const entry = {
    id: 'e5',
    playId: 'p',
    sceneId: 's1',
    orderIndex: 1,
    screenSpec: 'standard',
    slots: 1,
    durationMin: 20,
    changeoverMin: 10,
    startMin: 0,
    endMin: 20,
    setMin: 30,
    delayMin: 0,
    blockedBySceneIds: [],
    confirmedAt: '2026-10-03T10:03:00.000Z',
    createdAt: '2026-10-03T10:03:00.000Z',
    updatedAt: '2026-10-03T10:03:00.000Z',
  };
  const scenes = [scene('s1', 1, 20), scene('s2', 2, 20)];
  const plan = buildTurnoverPlan(scenes, [entry], 45);
  assert(plan.rows[0].setMin === 30, '已开排 s1 换景仍为账上 10′');
  assert(plan.rows[1].setMin === 20 + 45, `未开排 s2 用新换景 45′，setMin=65（实际 ${plan.rows[1].setMin}）`);
}

if (failures > 0) {
  console.error(`\n${failures} 项断言失败`);
  process.exit(1);
} else {
  console.log('\n全部断言通过');
}
