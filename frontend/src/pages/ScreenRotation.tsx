/**
 * /plays/:id/rotation 影窗周转账
 * 三台标准影窗（双联占两台），按开排顺序占台；散场后留换景时间才放窗；
 * 容量不够排队顺延并写明被哪场占着。场次时长/顺序/规格改动后未开排周转自动重算。
 * 写账（开排确认）失败可重试，接着最后确认的一场往下走，同一场不重复占台。
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Alert,
  App,
  Button,
  Col,
  Empty,
  InputNumber,
  Row,
  Space,
  Statistic,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import {
  ArrowLeftOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { ROUTES } from '../router';
import { usePlayStore } from '../stores/playStore';
import { useRotationStore } from '../stores/rotationStore';
import { STANDARD_BAY_COUNT } from '../utils/screenRotation';
import { SHADOW_SCREEN_LABEL } from '../types/scene';
import { minutesToClock, minutesToReadable } from '../utils/timecode';
import { EmptyState } from '../components/common/EmptyState';
import type { PlannedEntry } from '../utils/rotationLedger';

export default function ScreenRotation() {
  const { id: playId = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { message } = App.useApp();

  const play = usePlayStore((state) => state.plays.find((item) => item.id === playId) ?? null);
  const selectPlay = usePlayStore((state) => state.selectPlay);

  const {
    scenes,
    settings,
    plan,
    confirmedCount,
    stale,
    loading,
    committing,
    error,
    lastCommit,
    load,
    saveSettings,
    confirmUpTo,
    retryCommit,
  } = useRotationStore();

  const [changeoverDraft, setChangeoverDraft] = useState<number>(settings.changeoverMin);

  useEffect(() => {
    if (playId) {
      void selectPlay(playId);
      void load(playId);
    }
  }, [playId, selectPlay, load]);

  useEffect(() => {
    setChangeoverDraft(settings.changeoverMin);
  }, [settings.changeoverMin]);

  const sceneTitleById = useMemo(() => {
    const map = new Map(scenes.map((scene) => [scene.id, `第 ${scene.seq} 场·${scene.title}`]));
    return (id: string): string => map.get(id) ?? id;
  }, [scenes]);

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

  const handleConfirm = async (seq: number) => {
    const result = await confirmUpTo(seq);
    if (result.ok) {
      message.success(`已开排确认到第 ${result.lastConfirmedSeq} 场，占台已落账`);
    } else {
      message.error(`写账失败（第「${sceneTitleById(result.failedSceneId ?? '')}」）：${result.error ?? ''}；可点「重试写账」接着写`);
    }
  };

  const handleRetry = async () => {
    const result = await retryCommit();
    if (result.ok) message.success('重试成功，周转账已续写到目标场次');
    else message.error(`重试仍失败：${result.error ?? ''}`);
  };

  const columns: ColumnsType<PlannedEntry> = [
    {
      title: '场序',
      dataIndex: 'seq',
      width: 64,
      render: (seq: number) => <strong style={{ color: '#7a1f1f' }}>{seq}</strong>,
    },
    {
      title: '场次',
      dataIndex: 'title',
      render: (title: string, record) => (
        <Space size={6} wrap>
          <span>{title}</span>
          {record.status === 'confirmed' ? (
            <Tag color="success" icon={<CheckCircleOutlined />}>
              已开排
            </Tag>
          ) : (
            <Tag>未开排</Tag>
          )}
          {record.delayed && <Tag color="warning">排队顺延</Tag>}
        </Space>
      ),
    },
    {
      title: '影窗规格',
      dataIndex: 'spec',
      width: 150,
      render: (spec: PlannedEntry['spec']) => SHADOW_SCREEN_LABEL[spec],
    },
    {
      title: '占窗',
      dataIndex: 'bays',
      width: 110,
      render: (bays: number[]) => (
        <Space size={4}>
          {bays.map((bay) => (
            <Tag key={bay} color={bays.length > 1 ? '#7a1f1f' : 'gold'} style={{ marginInlineEnd: 0 }}>
              {bay} 号窗
            </Tag>
          ))}
        </Space>
      ),
    },
    {
      title: '上台时刻',
      dataIndex: 'startMin',
      width: 90,
      render: (value: number) => minutesToClock(value),
    },
    {
      title: '散场',
      dataIndex: 'endMin',
      width: 90,
      render: (value: number) => minutesToClock(value),
    },
    {
      title: '换景完放窗',
      dataIndex: 'releaseMin',
      width: 110,
      render: (value: number) => (
        <Tooltip title="本场散场后留够换景时间，窗位此刻才释放给下一场">
          <span>
            {minutesToClock(value)} <ClockCircleOutlined style={{ color: '#c9963c' }} />
          </span>
        </Tooltip>
      ),
    },
    {
      title: '被哪场占着',
      dataIndex: 'blockedBySceneIds',
      render: (ids: string[], record) => {
        if (!record.delayed) return <Typography.Text type="secondary">窗位有空，直接上台</Typography.Text>;
        const waiting = new Set(record.waitingForSceneIds);
        return (
          <Space size={4} wrap>
            {ids.map((id) => (
              <Tag key={id} color={waiting.has(id) ? 'volcano' : 'default'}>
                {sceneTitleById(id)}
                {waiting.has(id) ? '（等它放窗）' : ''}
              </Tag>
            ))}
          </Space>
        );
      },
    },
    {
      title: '操作',
      key: 'action',
      width: 160,
      render: (_, record) => {
        if (record.status === 'confirmed') {
          return <Typography.Text type="secondary">已锁定占台</Typography.Text>;
        }
        if (record.seq !== nextSeq) {
          return <Typography.Text type="secondary">等前序场次开排</Typography.Text>;
        }
        return (
          <Button
            size="small"
            type="primary"
            ghost
            loading={committing}
            onClick={() => void handleConfirm(record.seq)}
          >
            {confirmedCount === 0 ? '开排写第 1 场' : `开排（写到第 ${record.seq} 场）`}
          </Button>
        );
      },
    },
  ];

  const delayedCount = plan?.entries.filter((entry) => entry.delayed).length ?? 0;
  // 开排必须按场序推进：只有紧接已开排之后的下一场可以点（一次把前面未开排的都写账）
  const nextSeq = confirmedCount + 1;

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
            <Tag color="gold">后台 {STANDARD_BAY_COUNT} 台标准影窗</Tag>
            <Tag>双联影窗占两台</Tag>
          </Space>
          <Space wrap>
            <Button icon={<ReloadOutlined />} onClick={() => void load(playId)} loading={loading}>
              重算未开排
            </Button>
            {lastCommit && !lastCommit.ok ? (
              <Button type="primary" danger icon={<ClockCircleOutlined />} loading={committing} onClick={() => void handleRetry()}>
                重试写账（已确认到第 {lastCommit.lastConfirmedSeq} 场）
              </Button>
            ) : null}
          </Space>
        </div>

        <Row gutter={16}>
          <Col xs={12} md={6}>
            <Statistic title="场次总数" value={scenes.length} suffix="场" />
          </Col>
          <Col xs={12} md={6}>
            <Statistic title="已开排落账" value={confirmedCount} suffix={`/ ${scenes.length} 场`} />
          </Col>
          <Col xs={12} md={6}>
            <Statistic title="需排队顺延" value={delayedCount} suffix="场" />
          </Col>
          <Col xs={12} md={6}>
            <Statistic title="全部换景完散场" value={plan ? minutesToClock(plan.finishMin) : '—'} />
          </Col>
        </Row>

        <div style={{ margin: '14px 0 4px' }}>
          <Space size={12} wrap>
            <Typography.Text strong>换景时间：</Typography.Text>
            <InputNumber
              min={0}
              max={120}
              value={changeoverDraft}
              addonAfter="分钟"
              onChange={(value) => setChangeoverDraft(typeof value === 'number' ? value : settings.changeoverMin)}
            />
            <Button
              disabled={changeoverDraft === settings.changeoverMin}
              onClick={() => void saveSettings({ changeoverMin: changeoverDraft })}
            >
              保存并重算
            </Button>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              散场后窗位保留这么久才放下一场；改设置只影响未开排部分，已开排账行锁定。
            </Typography.Text>
          </Space>
        </div>
      </div>

      {error ? <Alert type="error" showIcon message={`周转账读取/写入异常：${error}`} /> : null}
      {stale ? (
        <Alert
          type="info"
          showIcon
          message="场次时长、顺序或影窗规格有改动：未开排的周转已按当前场次作废重算；已开排场次占台不变。"
        />
      ) : null}
      {lastCommit && !lastCommit.ok ? (
        <Alert
          type="warning"
          showIcon
          message={`写账在「${sceneTitleById(lastCommit.failedSceneId ?? '')}」失败，前 ${lastCommit.lastConfirmedSeq} 场已落账保留。点「重试写账」会接着第 ${lastCommit.lastConfirmedSeq + 1} 场往下写，同一场不重复占台。`}
        />
      ) : null}

      <div className="gb-panel">
        {plan && plan.entries.length > 0 ? (
          <Table<PlannedEntry>
            rowKey="sceneId"
            columns={columns}
            dataSource={plan.entries}
            pagination={false}
            size="middle"
            loading={loading}
            rowClassName={(record) => (record.status === 'confirmed' ? 'gb-row-confirmed' : '')}
            summary={() => (
              <Table.Summary fixed>
                <Table.Summary.Row>
                  <Table.Summary.Cell index={0} colSpan={4}>
                    <Typography.Text strong>周转口径</Typography.Text>
                  </Table.Summary.Cell>
                  <Table.Summary.Cell index={1} colSpan={5}>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      按场序逐场占台；容量不够（双联凑不齐两台）即排队顺延；总占窗时长约 {minutesToReadable(plan?.finishMin ?? 0)}
                      （含每场 {settings.changeoverMin} 分钟换景）。没登记规格的旧场次按一台标准影窗算。
                    </Typography.Text>
                  </Table.Summary.Cell>
                </Table.Summary.Row>
              </Table.Summary>
            )}
          />
        ) : (
          <Empty
            description={
              loading
                ? '读取周转账中…'
                : '这出戏还没有场次，先到「场次拆分」登记场次时长与影窗规格'
            }
          >
            <Button type="primary" onClick={() => navigate(ROUTES.scenes(playId))}>
              去场次拆分
            </Button>
          </Empty>
        )}
      </div>
    </Space>
  );
}
