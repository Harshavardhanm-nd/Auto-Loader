import React from 'react';

/**
 * The DLCM stage graph, drawn from the model rather than traced from the chart.
 *
 * The editorial choice: **operator-driven arrows are drawn solid and labelled inline; every
 * other arrow is dashed and unlabelled**, with its label on hover and in the list beneath. Seven
 * of the twenty-six transitions are things you send a CSV for — those are the ones worth reading
 * off a picture. The other nineteen belong to the Installer App, the customer, the network, the
 * order integration, and the useful thing to know about them is that they are not yours.
 *
 * Layout is a fixed grid carried in `stage.layout`, so a stage cannot be lost: the server test
 * asserts every stage has a slot and no two share one.
 */

const NODE_W = 152;
const NODE_H = 52;
const COL_GAP = 74;
const ROW_GAP = 44;
const PAD_X = 88;
const PAD_Y = 30;

const x0 = (col) => PAD_X + col * (NODE_W + COL_GAP);
const y0 = (row) => PAD_Y + row * (NODE_H + ROW_GAP);

export default function LifecycleMap({
  lifecycle,
  counts = {},
  selected = null,
  onSelect = () => {},
  currentCode = null,
}) {
  const { stages, transitions } = lifecycle;

  const sendableOperations = React.useMemo(
    () => new Set((lifecycle.operations ?? []).filter((o) => o.hasTemplate).map((o) => o.id)),
    [lifecycle.operations]
  );

  const box = React.useMemo(() => {
    const map = new Map();
    for (const s of stages) {
      const x = x0(s.layout.col);
      const y = y0(s.layout.row);
      map.set(s.code, { x, y, w: NODE_W, h: NODE_H, cx: x + NODE_W / 2, cy: y + NODE_H / 2, stage: s });
    }
    return map;
  }, [stages]);

  const cols = Math.max(...stages.map((s) => s.layout.col)) + 1;
  const rows = Math.max(...stages.map((s) => s.layout.row)) + 1;
  const width = x0(cols - 1) + NODE_W + PAD_X;
  const height = y0(rows - 1) + NODE_H + PAD_Y;

  const channelLeft = 34;
  const channelRight = width - 34;

  /**
   * Margin-channel arrows get their own lane, one per destination.
   *
   * Three transitions leave NF OOW down the right margin and would otherwise be drawn on top of
   * each other. The two refurbish arrows deliberately share a lane — they are one arrow on the
   * original chart, converging on the same stage, so merging them is the honest drawing.
   */
  const lanes = React.useMemo(() => {
    const perRoute = new Map();
    const out = new Map();
    for (const t of transitions) {
      if (t.route !== 'channelLeft' && t.route !== 'channelRight') continue;
      const seen = perRoute.get(t.route) ?? [];
      let lane = seen.indexOf(t.to);
      if (lane === -1) {
        lane = seen.length;
        seen.push(t.to);
        perRoute.set(t.route, seen);
      }
      out.set(t.key + t.label, lane);
    }
    return out;
  }, [transitions]);

  const edges = transitions
    .map((t) => {
      const lane = lanes.get(t.key + t.label) ?? 0;
      const step = t.route === 'channelRight' ? -16 : 16;
      return {
        t,
        path: route(t, box, {
          channelLeft: channelLeft + (t.route === 'channelLeft' ? lane * step : 0),
          channelRight: channelRight + (t.route === 'channelRight' ? lane * step : 0),
        }),
      };
    })
    .filter((e) => e.path);

  // Move To Dead is three transitions converging on one point, so its label would be drawn three
  // times on top of itself. Identical text landing in the same place is drawn once.
  const labelled = React.useMemo(() => {
    const drawn = [];
    return edges
      .filter((e) => e.t.operation)
      .map((e) => {
        const clash = drawn.some(
          (d) => d.label === e.t.label && Math.abs(d.lx - e.path.lx) < 14 && Math.abs(d.ly - e.path.ly) < 14
        );
        if (!clash) drawn.push({ label: e.t.label, lx: e.path.lx, ly: e.path.ly });
        return { ...e, showLabel: !clash };
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transitions, box]);

  return (
    <div className="lc-map-wrap">
      <svg
        className="lc-map"
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="Device life cycle stage graph"
      >
        <defs>
          <marker id="lc-head" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
            <path d="M0,0 L8,4 L0,8 z" fill="var(--accent)" />
          </marker>
          <marker
            id="lc-head-ext"
            viewBox="0 0 8 8"
            refX="7"
            refY="4"
            markerWidth="6.5"
            markerHeight="6.5"
            orient="auto"
          >
            <path d="M0,0 L8,4 L0,8 z" fill="var(--ink-faint)" />
          </marker>
          <marker id="lc-head-pale" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
            <path d="M0,0 L8,4 L0,8 z" fill="var(--accent-soft)" />
          </marker>
        </defs>

        {/* External arrows first, so the operator's own path draws over them. */}
        {edges
          .filter((e) => e.t.external)
          .map((e) => (
            <path key={e.t.key + e.t.label} className="lc-edge ext" d={e.path.d} markerEnd="url(#lc-head-ext)">
              <title>{`${e.t.label} — ${e.t.actor}`}</title>
            </path>
          ))}

        {labelled.map(({ t, path }) => {
          // An operation with no sheet is yours on the chart and unsendable in practice. Drawn
          // lighter so the spine of the map is the chain you can actually walk.
          const sendable = sendableOperations.has(t.operation);
          return (
            <path
              key={t.key + t.label}
              className={`lc-edge op${sendable ? '' : ' no-sheet'}`}
              d={path.d}
              markerEnd={sendable ? 'url(#lc-head)' : 'url(#lc-head-pale)'}
            >
              <title>{`${t.label} — ${sendable ? 'you send this' : 'yours, but no CSV format exists yet'}`}</title>
            </path>
          );
        })}

        {stages.map((s) => {
          const b = box.get(s.code);
          const here = counts[s.code] ?? 0;
          const isCurrent = currentCode !== null && Number(currentCode) === s.code;
          return (
            <g
              key={s.code}
              className={[
                'lc-node',
                `acct-${s.account}`,
                selected === s.code ? 'is-selected' : '',
                isCurrent ? 'is-current' : '',
                here ? 'has-devices' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              onClick={() => onSelect(selected === s.code ? null : s.code)}
              tabIndex={0}
              role="button"
              aria-pressed={selected === s.code}
              onKeyDown={(ev) => {
                if (ev.key === 'Enter' || ev.key === ' ') {
                  ev.preventDefault();
                  onSelect(selected === s.code ? null : s.code);
                }
              }}
            >
              {/* Classed, because the count chip is also a rect inside this group and must not
                  inherit the node's fill. */}
              <rect className="lc-node-box" x={b.x} y={b.y} width={b.w} height={b.h} rx="3" />
              <text className="lc-node-code" x={b.x + 9} y={b.y + 16}>
                {s.code}
              </text>
              {here ? (
                <>
                  <rect className="lc-count-bg" x={b.x + b.w - 40} y={b.y + 6} width="34" height="15" rx="2" />
                  <text className="lc-count" x={b.x + b.w - 23} y={b.y + 17} textAnchor="middle">
                    {here}
                  </text>
                </>
              ) : null}
              <text className="lc-node-label" x={b.x + 9} y={b.y + 36}>
                {fit(s.label)}
              </text>
              <title>{s.note ?? s.label}</title>
            </g>
          );
        })}

        {/* Labels last: a node box drawn afterwards would paint over the text. */}
        {labelled
          .filter((e) => e.showLabel)
          .map(({ t, path }) => (
            <text
              key={`label-${t.key}-${t.label}`}
              className={`lc-edge-label${sendableOperations.has(t.operation) ? '' : ' no-sheet'}`}
              x={path.lx}
              y={path.ly}
              textAnchor="middle"
            >
              {t.label}
            </text>
          ))}
      </svg>
    </div>
  );
}

/** Long stage names get an ellipsis rather than overflowing the box. */
function fit(label, max = 21) {
  return label.length > max ? `${label.slice(0, max - 1)}…` : label;
}

/**
 * Orthogonal routing for a fixed graph.
 *
 * Not a general router — it handles the six shapes this chart actually contains, picked by an
 * explicit `route` hint where the geometry is ambiguous. Every path is axis-aligned, which is
 * what makes a state diagram readable.
 */
function route(t, box, { channelLeft, channelRight }) {
  const to = box.get(t.to);
  if (!to) return null;

  // Entry: the initial load, arriving from outside the graph.
  if (t.from === null) {
    // The label sits above the row rather than on the arrow: the gap between two boxes is
    // narrower than the label, so on-the-line text would run over their edges.
    return {
      d: `M ${channelLeft} ${to.cy} H ${to.x - 4}`,
      lx: (channelLeft + to.x) / 2,
      ly: to.y - 10,
    };
  }

  const from = box.get(t.from);
  if (!from) return null;

  const sameRow = from.stage.layout.row === to.stage.layout.row;
  const sameCol = from.stage.layout.col === to.stage.layout.col;
  const rightward = to.x > from.x;
  const downward = to.y > from.y;

  if (t.route === 'above') {
    const y = Math.min(from.y, to.y) - ROW_GAP / 2 - 6;
    return {
      d: `M ${from.cx + 26} ${from.y} V ${y} H ${to.cx + 26} V ${to.y - 4}`,
      lx: (from.cx + to.cx) / 2 + 26,
      ly: y - 6,
    };
  }

  if (t.route === 'below') {
    const y = Math.max(from.y + from.h, to.y + to.h) + ROW_GAP / 2 - 4;
    return {
      d: `M ${from.cx - 26} ${from.y + from.h} V ${y} H ${to.cx - 26} V ${to.y + to.h + 4}`,
      lx: (from.cx + to.cx) / 2,
      ly: y + 13,
    };
  }

  // A local elbow just outside the source's left edge — the "removed from vehicle" return.
  if (t.route === 'left') {
    const x = Math.min(from.x, to.x) - 30;
    return {
      d: `M ${from.x} ${from.cy} H ${x} V ${to.cy} H ${to.x - 4}`,
      lx: x - 4,
      ly: (from.cy + to.cy) / 2,
    };
  }

  // The margin channels, for the long returns that cross most of the chart.
  //
  // Always leave through the bottom rather than the side: a sideways exit runs along the source's
  // own row and puts the line straight through whatever else is on it — the refurbish arrow out
  // of Returned Non-RMA crosses Returned RMA that way. The entry edge is declared per transition
  // for the same reason.
  if (t.route === 'channelRight' || t.route === 'channelLeft') {
    const isRight = t.route === 'channelRight';
    const channel = isRight ? channelRight : channelLeft;
    const drop = from.y + from.h + ROW_GAP / 2;

    if (t.enter === 'bottom') {
      // Come up into the target's underside, offset from its centre so it does not collide with
      // whatever else uses that edge. The approach runs along the far side of the row gap, since
      // the near side is already taken by the "below" route.
      const approach = to.y + to.h + ROW_GAP - 10;
      const enterX = to.cx + 26;
      return {
        d: `M ${from.cx} ${from.y + from.h} V ${drop} H ${channel} V ${approach} H ${enterX} V ${to.y + to.h + 4}`,
        lx: channel + (isRight ? -40 : 40),
        ly: (drop + approach) / 2,
      };
    }

    const enterSide = isRight ? to.x + to.w + 4 : to.x - 4;
    return {
      d: `M ${from.cx} ${from.y + from.h} V ${drop} H ${channel} V ${to.cy} H ${enterSide}`,
      lx: channel + (isRight ? -40 : 40),
      ly: (drop + to.cy) / 2,
    };
  }

  if (sameCol) {
    // Downward runs use the column centre; upward runs are offset so the pair does not overlap.
    const dx = downward ? 0 : 30;
    return downward
      ? {
          d: `M ${from.cx} ${from.y + from.h} V ${to.y - 4}`,
          lx: from.cx + 6,
          ly: (from.y + from.h + to.y) / 2 + 4,
        }
      : {
          d: `M ${from.cx + dx} ${from.y} V ${to.y + to.h + 4}`,
          lx: from.cx + dx + 6,
          ly: (from.y + to.y + to.h) / 2,
        };
  }

  if (sameRow) {
    return rightward
      ? {
          d: `M ${from.x + from.w} ${from.cy} H ${to.x - 4}`,
          lx: (from.x + from.w + to.x) / 2,
          ly: from.y - 10,
        }
      : {
          d: `M ${from.x} ${from.cy + 12} H ${to.x + to.w + 4}`,
          lx: (from.x + to.x + to.w) / 2,
          ly: from.cy + 25,
        };
  }

  // Diagonal: drop into the channel between the two rows, run across, then in through the top.
  const midY = downward
    ? Math.min(to.y, from.y + from.h) + (Math.abs(to.y - (from.y + from.h)) / 2 || ROW_GAP / 2)
    : to.y + to.h + ROW_GAP / 2;
  // An upward diagonal enters the target's underside, which is also where that stage's own
  // outgoing arrow leaves. Offsetting keeps the two from reading as one line.
  const enterX = downward ? to.cx : to.cx - 26;
  return {
    d: downward
      ? `M ${from.cx} ${from.y + from.h} V ${midY} H ${enterX} V ${to.y - 4}`
      : `M ${from.cx} ${from.y} V ${midY} H ${enterX} V ${to.y + to.h + 4}`,
    lx: (from.cx + enterX) / 2,
    ly: midY - 6,
  };
}
