/**
 * /plays/:id/turnover 影窗周转账
 *
 * 后台三台标准影窗（双联占两台），按场序逐场占台写账：
 * - 台口甘特图直观看谁占着几号台、散场后留了多久换景；
 * - 「确认下一场开排」把该场账写进 IndexedDB（同场幂等，失败可重试）；
 * - 已开排锁定，时长/顺序/规格改动只让未开排的排期作废重算。
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Alert,
  App,
  Button,
  Col,
  InputNumber,
  Popconfirm,
  Row,
  Space,
  Statistic,
  Table,
  Tag,
  TimePicker,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  ArrowLeftOutlined,
  CheckCircleOutlined,
  FastForwardOutlined,
  ReadOutlined,
  RedoOutlined,
  UndoOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import { usePlayStore } from '../stores/playStore';
import { useTurnoverStore } from '../stores/turnoverStore';
import { EmptyState } from '../components/common/EmptyState';
import { ROUTES } from '../router';
import { SCREEN_CAPACITY } from '../types/turnover';
import { SHADOW_SCREEN_LABEL } from '../types/scene';
import { minutesToReadable, relativeMinuteToClock } from '../utils/timecode';
import { formatStamp } from '../utils/uuid';
import { buildTurnoverPlan, type ScheduleRow } from '../utils/turnoverScheduler';

/** 甘特图里一场占台块的泳道分配结果：lane 为起始台口号（0 起），span 为跨几个台口 */
interface LanePlaced {
  row: ScheduleRow;
  lane: number;
  span: number;
}

/**
 * 贪心把每场（含散场后的换景占位）塞进 3 条台口泳道：
 * 每场占台区间为 [startMin, setMin)，双联需要两条相邻台口同时空。
 */
function assignLanes(rows: ScheduleRow[]): LanePlaced[] {
  const lanes: Array<{ freeAt: number }[]> = [[], [], []];
  const placed: LanePlaced[] = [];

  const sorted = [...rows].sort((a, b) => a.startMin - b.startMin || b.slots - a.slots);
  sorted.forEach((row) => {
    const span = Math.min(row.slots, SCREEN_CAPACITY);
    let chosen = -1;
    for (let start = 0; start + span <= SCREEN_CAPACITY; start += 1) {
      let ok = true;
      for (let k = 0; k < span; k += 1) {
        const lane = lanes[start + k];
        if (lane.some((item) => item.freeAt > row.startMin)) {
          ok = false;
          break;
        }
      }
      if (ok) {
        chosen = start;
        break;
      }
    }
    if (chosen < 0) chosen = 0; // 理论不可达：容量约束已在排程层保证
    for (let k = 0; k < span; k += 1) {
      lanes[chosen + k].push({ freeAt: row.setMin });
    }
    placed.push({ row, lane: chosen, span });
  });

  return placed;
}

/** 甘特图时间轴刻度：按总时长选 20/30/60 分钟步长 */
function buildGanttTicks(totalMin: number): number[] {
  if (totalMin <= 0) return [0];
  const targetTicks = 10;
  const raw = totalMin / targetTicks;
  const step = raw <= 20 ? 20 : raw <= 30 ? 30 : 60;
  const ticks: number[] = [];
  for (let t = 0; t <= totalMin; t += step) ticks.push(t);
  if (ticks[ticks.length - 1] !== totalMin) ticks.push(totalMin);
  return ticks;
}

const SPEC_TAG_COLOR: Record<string, string> = {
  small: 'default',
  standard: 'blue',
  large: 'gold',
  twin: 'purple',
};

export default function TurnoverBoard() {
  const { id: playId = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { message } = App.useApp();

  const plays = usePlayStore((state) => state.plays);
  const selectPlay = usePlayStore((state) => state.selectPlay);

  const scenes = useTurnoverStore((state) => state.scenes);
  const entries = useTurnoverStore((state) => state.entries);
  const loading = useTurnoverStore((state) => state.loading);
  const writing = useTurnoverStore((state) => state.writing);
  const error = useTurnoverStore((state) => state.error);
  const lastWriteError = useTurnoverStore((state) => state.lastWriteError);
  const changeoverMin = useTurnoverStore((state) => state.changeoverMin);
  const baseClockMin = useTurnoverStore((state) => state.baseClockMin);
  const loadTurnover = useTurnoverStore((state) => state.loadTurnover);
  const confirmNext = useTurnoverStore((state) => state.confirmNext);
  const confirmAll = useTurnoverStore((state) => state.confirmAll);
  const rollbackLast = useTurnoverStore((state) => state.rollbackLast);
  const resetLedger = useTurnoverStore((state) => state.resetLedger);
  const setChangeoverMin = useTurnoverStore((state) => state.setChangeoverMin);
  const setBaseClockMin = useTurnoverStore((state) => state.setBaseClockMin);

  const [retrying, setRetrying] = useState(false);

  const play = plays.find((item) => item.id === playId) ?? null;

  useEffect(() => {
    if (playId) selectPlay(playId);
  }, [playId, selectPlay]);

  useEffect(() => {
    if (playId) void loadTurnover(playId);
  }, [playId, loadTurnover]);

  // 每次 scenes / entries / 换景设置变化都会重算——未开排排期即「作废重算」
  const plan = useMemo(
    () => buildTurnoverPlan(scenes, entries, changeoverMin),
    [scenes, entries, changeoverMin],
  );

  const placed = useMemo(() => (plan ? assignLanes(plan.rows) : []), [plan]);
  const titleOf = useMemo(() => {
    const map = new Map<string, string>();
    scenes.forEach((scene) => map.set(scene.id, scene.title));
    entries.forEach((entry) => map.set(entry.sceneId, `已删第 ${entry.orderIndex} 场`));
    return (id: string): string => map.get(id) ?? id;
  }, [scenes, entries]);

  const totalSpanMin = plan ? Math.max(plan.finishMin, 1) : 1;
  const ticks = useMemo(() => buildGanttTicks(totalSpanMin), [totalSpanMin]);
  const driftRows = useMemo(() => (plan ? plan.rows.filter((row) => row.drift) : []), [plan]);
  const nextPending = useMemo(() => plan?.rows.find((row) => !row.confirmed) ?? null, [plan]);

  const clock = (offset: number): string => relativeMinuteToClock(baseClockMin, offset);

  const handleConfirmNext = async (): Promise<void> => {
    if (!nextPending) return;
    try {
      const result = await confirmNext();
      if (result) {
        message.success(
          result.delayMin > 0
            ? `「${result.sceneTitle}」已开排写账，台口不够顺延 ${minutesToReadable(result.delayMin)}`
            : `「${result.sceneTitle}」已准点开排写账`,
        );
      }
    } catch {
      message.error('写账失败，账未落库，可点「重试」从最后确认的一场接着写');
    }
  };

  const handleConfirmAll = async (): Promise<void> => {
    const result = await confirmAll();
    if (result.failedSceneTitle) {
      message.warning(`连写到「${result.failedSceneTitle}」时失败，已落 ${result.confirmed} 场，可重试续上`);
    } else if (result.confirmed > 0) {
      message.success(`全部场次已开排写账，共 ${result.confirmed} 场`);
    } else {
      message.info('没有待开排的场次');
    }
  };

  const handleRetry = async (): Promise<void> => {
    setRetrying(true);
    try {
      await handleConfirmNext();
    } finally {
      setRetrying(false);
    }
  };

  const baseClockValue = useMemo(
    () => dayjs().hour(Math.floor(baseClockMin / 60)).minute(baseClockMin % 60),
    [baseClockMin],
  );

  if (!play) {
    return (
      <div className="gb-panel">
        <EmptyState
          title="未找到该剧目"
          description="剧目可能已被删除，请回到剧目库重新选择。"
          actionText="回到剧目库"
          onAction={() => navigate(ROUTES.plays)}
        />
      </div>
    );
  }

  const columns: ColumnsType<ScheduleRow> = [
    {
      title: '场序',
      dataIndex: 'orderIndex',
      width: 56,
      align: 'center',
      render: (value: number) => <b style={{ color: '#7a1f1f' }}>{value}</b>,
    },
    {
      title: '场次',
      dataIndex: 'title',
      render: (value: string, row) => (
        <Space size={6} wrap>
          <span>{value}</span>
          {row.confirmed ? <Tag color="green">已开排</Tag> : <Tag>未开排</Tag>}
          {row.drift && <Tag color="orange">账后改过</Tag>}
        </Space>
      ),
    },
    {
      title: '影窗规格',
      dataIndex: 'spec',
      width: 150,
      render: (value: ScheduleRow['spec'], row) => (
        <Tooltip title={row.slots > 1 ? '双联影窗按两台标准影窗占台' : '按一台标准影窗占台'}>
          <Tag color={SPEC_TAG_COLOR[value]}>{SHADOW_SCREEN_LABEL[value]}</Tag>
        </Tooltip>
      ),
    },
    {
      title: '占台口',
      dataIndex: 'slots',
      width: 76,
      align: 'center',
      render: (value: number) => `${value} / ${SCREEN_CAPACITY}`,
    },
    {
      title: '开台',
      dataIndex: 'startMin',
      width: 118,
      render: (value: number) => <span className="gb-mono">{clock(value)}</span>,
    },
    {
      title: '时长',
      dataIndex: 'durationMin',
      width: 72,
      align: 'center',
      render: (value: number) => `${value}′`,
    },
    {
      title: `换景留白`,
      dataIndex: 'changeoverMin',
      width: 84,
      align: 'center',
      render: (value: number) => `${value}′`,
    },
    {
      title: '放台',
      dataIndex: 'setMin',
      width: 118,
      render: (value: number) => <span className="gb-mono">{clock(value)}</span>,
    },
    {
      title: '顺延',
      dataIndex: 'delayMin',
      width: 96,
      render: (value: number) =>
        value > 0 ? <Tag color="volcano">+{minutesToReadable(value)}</Tag> : <Tag color="green">准点</Tag>,
    },
    {
      title: '被哪场占着',
      dataIndex: 'blockedBySceneIds',
      render: (ids: string[]) =>
        ids.length === 0 ? (
          <Typography.Text type="secondary">—</Typography.Text>
        ) : (
          <Space size={4} wrap>
            {ids.map((id) => (
              <Tag key={id} color="red">
                {titleOf(id)}
              </Tag>
            ))}
          </Space>
        ),
    },
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <div className="gb-panel">
        <div className="gb-panel-title">
          <Space size={10} wrap>
            <Button icon={<ArrowLeftOutlined />} onClick={() => navigate(ROUTES.scenes(playId))}>
              场次拆分
            </Button>
            <Typography.Title level={4} style={{ margin: 0 }}>
              影窗周转账 · {play.title}
            </Typography.Title>
            <Tag color="red">后台 {SCREEN_CAPACITY} 台标准影窗</Tag>
            <Tag>已开排 {plan?.confirmedCount ?? 0} 场</Tag>
            <Tag color="gold">待开排 {plan?.pendingCount ?? 0} 场</Tag>
          </Space>
          <Space wrap>
            <Button
              type="primary"
              icon={<CheckCircleOutlined />}
              loading={writing || retrying}
              disabled={!nextPending}
              onClick={() => void handleConfirmNext()}
            >
              确认下一场开排{nextPending ? `：${nextPending.title}` : ''}
            </Button>
            <Button
              icon={<FastForwardOutlined />}
              loading={writing}
              disabled={!nextPending}
              onClick={() => void handleConfirmAll()}
            >
              一次开完
            </Button>
            <Button icon={<UndoOutlined />} loading={writing} disabled={entries.length === 0} onClick={() => void rollbackLast()}>
              回退末场
            </Button>
            <Popconfirm
              title="清空本剧目的周转账？"
              description="已开排账本条全部删除，所有场次回到未开排重新排队。"
              okText="清空重排"
              okButtonProps={{ danger: true }}
              cancelText="取消"
              onConfirm={() => void resetLedger().then(() => message.success('周转账已清空，全部场次重新排队'))}
            >
              <Button danger icon={<RedoOutlined />} loading={writing} disabled={entries.length === 0}>
                清空账本
              </Button>
            </Popconfirm>
          </Space>
        </div>

        <Row gutter={16}>
          <Col xs={12} md={6}>
            <Statistic title="已开排 / 总场次" value={plan?.confirmedCount ?? 0} suffix={`/ ${scenes.length}`} />
          </Col>
          <Col xs={12} md={6}>
            <Statistic title="未开排顺延场次" value={plan?.delayedCount ?? 0} suffix="场" />
          </Col>
          <Col xs={12} md={6}>
            <Statistic title="整场散台" value={clock(plan?.finishMin ?? 0)} />
          </Col>
          <Col xs={12} md={6}>
            <Space direction="vertical" size={2}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                散场换景留白
              </Typography.Text>
              <InputNumber
                min={0}
                max={120}
                value={changeoverMin}
                addonAfter="分钟"
                style={{ width: 130 }}
                onChange={(value) => setChangeoverMin(typeof value === 'number' ? value : 0)}
              />
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                开排基准
                <TimePicker
                  size="small"
                  allowClear={false}
                  format="HH:mm"
                  hideDisabledOptions
                  style={{ width: 92, marginLeft: 6 }}
                  value={baseClockValue}
                  onChange={(value) => {
                    if (value) setBaseClockMin(value.hour() * 60 + value.minute());
                  }}
                />
              </Typography.Text>
            </Space>
          </Col>
        </Row>
      </div>

      <Alert
        type="info"
        showIcon
        banner
        message="占台规矩"
        description={
          <Typography.Text style={{ fontSize: 13 }}>
            按开排顺序（场序）逐场占台；每场登记什么规格就占几个台口——双联影窗算两台，小/标准/大影窗各占一台。
            散场后留够换景时间才放台给后面的场次；三台占满时后面的场次排队顺延，账上写明是被哪几场占着。
            已开排的账锁定不改；改动场次时长、顺序或影窗规格后，<b>未开排的周转当场作废、自动重算</b>。
          </Typography.Text>
        }
      />

      {lastWriteError ? (
        <Alert
          type="error"
          showIcon
          message={`写账失败：${lastWriteError}`}
          description="账本已停在最后确认的一场，未产生重复占台；点重试会为同一场重新占台写账。"
          action={
            <Button size="small" danger loading={retrying || writing} onClick={() => void handleRetry()}>
              重试写账
            </Button>
          }
        />
      ) : null}

      {driftRows.length > 0 ? (
        <Alert
          type="warning"
          showIcon
          message={`已开排的 ${driftRows.length} 场后来改过时长或影窗规格`}
          description="开排账按当时登记锁定，不翻旧账；改动只影响未开排场次。如确需按新数据重排，请「回退末场」到相应场次后重新开排。"
        />
      ) : null}

      {error ? <Alert type="error" showIcon message={`账本读取失败：${error}`} /> : null}

      {scenes.length === 0 && !loading ? (
        <div className="gb-panel">
          <EmptyState
            title="这出戏还没有场次"
            description="先去场次拆分里登记场次、时长与影窗规格，再回来排影窗周转。"
            actionText="去拆场次"
            onAction={() => navigate(ROUTES.scenes(playId))}
          />
        </div>
      ) : (
        <>
          <div className="gb-panel">
            <div className="gb-panel-title">
              <Typography.Text strong>
                <ReadOutlined /> 台口占台图（实线为上场，斜纹尾为散场换景留白）
              </Typography.Text>
              <Space size={6}>
                <Tag color="green">已开排锁定</Tag>
                <Tag color="blue">未开排预估</Tag>
                <Tag color="purple">双联占两台</Tag>
              </Space>
            </div>
            <ScreenGantt
              placed={placed}
              ticks={ticks}
              totalMin={totalSpanMin}
              clock={clock}
              capacity={SCREEN_CAPACITY}
              titleOf={titleOf}
            />
          </div>

          <div className="gb-panel">
            <div className="gb-panel-title">
              <Typography.Text strong>周转账明细（按开排顺序）</Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                最后确认：{entries.length > 0 ? formatStamp(entries[entries.length - 1].confirmedAt) : '尚未开排'}
              </Typography.Text>
            </div>
            <Table<ScheduleRow>
              className="gb-table-compact"
              size="small"
              rowKey="sceneId"
              loading={loading}
              columns={columns}
              dataSource={plan?.rows ?? []}
              pagination={false}
              rowClassName={(row) => (row.confirmed ? 'gb-ledger-confirmed' : 'gb-ledger-pending')}
            />
          </div>
        </>
      )}
    </Space>
  );
}

/* ------------------------------ 台口甘特图 ------------------------------ */

interface ScreenGanttProps {
  placed: LanePlaced[];
  ticks: number[];
  totalMin: number;
  clock: (offset: number) => string;
  capacity: number;
  titleOf: (id: string) => string;
}

function ScreenGantt({ placed, ticks, totalMin, clock, capacity, titleOf }: ScreenGanttProps) {
  const laneHeight = 58;
  const laneGap = 8;
  const headerHeight = 26;
  const chartHeight = headerHeight + capacity * laneHeight + (capacity - 1) * laneGap + 8;

  const pct = (minute: number): string => `${(Math.max(0, minute) / totalMin) * 100}%`;

  return (
    <div className="gb-gantt" style={{ height: chartHeight }}>
      <div className="gb-gantt-scale" style={{ height: headerHeight }}>
        {ticks.map((tick) => (
          <div key={tick} className="gb-gantt-tick" style={{ left: pct(tick) }}>
            <span>{clock(tick)}</span>
          </div>
        ))}
      </div>
      <div className="gb-gantt-lanes">
        {Array.from({ length: capacity }, (_, laneIndex) => (
          <div key={laneIndex} className="gb-gantt-lane" style={{ height: laneHeight, marginBottom: laneGap }}>
            <span className="gb-gantt-lane-label">{laneIndex + 1} 号台</span>
          </div>
        ))}
        {placed.map(({ row, lane, span }) => {
          const mainWidth = ((row.endMin - row.startMin) / totalMin) * 100;
          const coWidth = ((row.setMin - row.endMin) / totalMin) * 100;
          const top = headerHeight + lane * (laneHeight + laneGap) + 4;
          const height = laneHeight * span + laneGap * (span - 1) - 8;
          return (
            <Tooltip
              key={row.sceneId}
              title={
                <div>
                  <div>
                    第 {row.orderIndex} 场 · {row.title}（{SHADOW_SCREEN_LABEL[row.spec]}，占 {row.slots} 台）
                  </div>
                  <div>
                    {clock(row.startMin)} 开台 · {row.durationMin}′ · {clock(row.endMin)} 散场
                  </div>
                  <div>
                    换景 {row.changeoverMin}′，{clock(row.setMin)} 放台
                  </div>
                  {row.delayMin > 0 && <div>容量不足顺延 {minutesToReadable(row.delayMin)}</div>}
                  {row.blockedBySceneIds.length > 0 && (
                    <div>被占：{row.blockedBySceneIds.map((id) => titleOf(id)).join('、')}</div>
                  )}
                  <div>{row.confirmed ? '已开排（锁定）' : '未开排（预估）'}</div>
                </div>
              }
            >
              <div
                className={`gb-gantt-bar ${row.confirmed ? 'is-confirmed' : 'is-pending'} ${span > 1 ? 'is-twin' : ''}`}
                style={{ left: pct(row.startMin), width: pct(row.setMin - row.startMin), top, height }}
              >
                <div className="gb-gantt-bar-main" style={{ width: `${(mainWidth / (mainWidth + coWidth)) * 100}%` }}>
                  <span className="gb-gantt-bar-text">
                    {row.orderIndex}. {row.title}
                    {row.delayMin > 0 ? ` +${row.delayMin}′` : ''}
                  </span>
                </div>
                {coWidth > 0 && <div className="gb-gantt-bar-co" style={{ width: `${(coWidth / (mainWidth + coWidth)) * 100}%` }} />}
              </div>
            </Tooltip>
          );
        })}
      </div>
    </div>
  );
}
