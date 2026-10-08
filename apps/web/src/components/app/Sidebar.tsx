'use client';

import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type MouseEvent as ReactMouseEvent,
  type SyntheticEvent,
} from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { SidebarProject } from '@/lib/dashboard/types';
import { can, type ActorRole } from '@nia/schemas';
import {
  navGroupLabelStyle,
  navRailBtnLabelStyle,
  navRailBtnStyle,
  navRailExpandToggleStyle,
  navRailFooterStyle,
  navRailHandleStyle,
  navRailScrollStyle,
  navRailSoonMetaStyle,
  navRailStyle,
  navTreeStatusDotStyle,
  navTreeStatusLabel,
  newProjectRowStyle,
  projectChevronStyle,
  projectRowStyle,
  projectsNestStyle,
  RAIL_COLLAPSE_THRESHOLD,
  RAIL_COLLAPSED_WIDTH,
  RAIL_MAX_WIDTH,
  RAIL_MIN_WIDTH,
  treeLabelStyle,
  workflowRowStyle,
} from './styles';
import {
  NxAgentsIcon,
  NxBillingIcon,
  NxChevronRightIcon,
  NxCollapseIcon,
  NxConnectionsIcon,
  NxDashboardIcon,
  NxHomeIcon,
  NxMembersIcon,
  NxProjectsIcon,
  NxSettingsIcon,
} from '@/components/canvas/navIcons';
import { useAppShellStore } from './store';
import CreateProjectDialog from './CreateProjectDialog';
import CreateWorkflowDialog from './CreateWorkflowDialog';

/**
 * The ONE sidebar used everywhere under /app/*, including the workflow
 * canvas — previously the canvas route rendered its own separate
 * CanvasIconRail.tsx, which had drifted both visually (no logo, unicode nav
 * glyphs, unicode Sign out avatar overlapping its own label — a real
 * layout bug) and functionally (no Projects tree, no org-governance
 * placeholder items) from this component. Per UI feedback ("keep only one,
 * use the Canvas one — it looks better, but keep the tree/org items"),
 * this now carries CanvasIconRail's visual chrome (Logo header, compact
 * icon "+New" button, SVG nav icons, footer Sign-out + Collapse toggle)
 * while keeping this file's own Projects tree, org-governance gating, and
 * railSnapping drag animation — nothing lost by consolidating.
 *
 * Nav structure mirrors designs/Nia Core App.html's `NAV` array: Org
 * dashboard, Home, Projects (tree), Platform group (Connections, Members &
 * roles, Audit log). Org dashboard / Members & roles / Audit log pages are
 * Step 3 work not yet built, so they render disabled; Connections and
 * Billing already have real pages so those are live links.
 *
 * Precision Dark redesign (Step 2): row chrome now uses the nx-* token
 * styles/icons (apps/web/src/components/app/styles.ts's navRail* functions
 * + canvas/navIcons.tsx's Nx* icon set) instead of the old --text/--surface
 * styles and unicode glyphs.
 *
 * The logo/wordmark lives in the header row beside this rail (TopBar.tsx's
 * first cell under AppShell, CanvasHeader.tsx's first cell on the workflow
 * canvas route) — this rail always starts directly with the nav rows, on
 * every route, with no logo cell of its own.
 */
export default function Sidebar({
  orgId,
  role,
  projects,
}: {
  orgId: string | null;
  role: ActorRole;
  projects: SidebarProject[];
}) {
  const pathname = usePathname();
  const railW = useAppShellStore((s) => s.railW);
  const railDrag = useAppShellStore((s) => s.railDrag);
  const setRailW = useAppShellStore((s) => s.setRailW);
  const setRailDrag = useAppShellStore((s) => s.setRailDrag);
  const toggleRailCollapse = useAppShellStore((s) => s.toggleRailCollapse);
  const navProjectsOpen = useAppShellStore((s) => s.navProjectsOpen);
  const toggleNavProjectsOpen = useAppShellStore((s) => s.toggleNavProjectsOpen);
  const openProject = useAppShellStore((s) => s.openProject);
  const toggleOpenProject = useAppShellStore((s) => s.toggleOpenProject);
  const setOpenProject = useAppShellStore((s) => s.setOpenProject);
  const [showCreateProject, setShowCreateProject] = useState(false);
  const [showCreateWorkflow, setShowCreateWorkflow] = useState(false);
  const [railSnapping, setRailSnapping] = useState(false);
  const dragRef = useRef<{ startX: number; startW: number } | null>(null);
  const snapTimeoutRef = useRef<number | null>(null);

  // Collapsed-rail hover label (Q5): a single shared piece of state driven
  // by whichever row is currently hovered/focused, rendered `position:
  // fixed` at the end of this component so it can never be clipped by the
  // scroll area's `overflow: auto` (portal not needed — fixed positioning
  // already escapes it, since no ancestor here sets a transform). Only
  // armed when the rail is collapsed; a no-op while wide.
  const [hoverLabel, setHoverLabel] = useState<{ text: string; top: number; left: number } | null>(null);

  // wide/narrow mirrors the design's `get wide(){ return railW >= 168 }` —
  // below that threshold the rail shows icon-only rows, same visual result
  // as the old boolean `collapsed` state but now driven by a live width.
  const wide = railW >= RAIL_MIN_WIDTH;

  function showHoverLabel(e: SyntheticEvent<HTMLElement>, text: string) {
    if (wide) return;
    const rect = e.currentTarget.getBoundingClientRect();
    setHoverLabel({ text, top: rect.top + rect.height / 2, left: rect.right + 8 });
  }
  function hideHoverLabel() {
    setHoverLabel(null);
  }

  // Auto-expand the project tree around the workflow whose canvas is
  // currently open, so landing directly on /app/workflows/:id (bookmark,
  // reload, or the workflow page's own render) highlights it without
  // requiring the user to have clicked through the tree first.
  useEffect(() => {
    const match = pathname.match(/^\/app\/workflows\/([^/]+)$/);
    if (!match) return;
    const workflowId = match[1];
    const owner = projects.find((p) => p.workflows.some((w) => w.id === workflowId));
    if (owner) setOpenProject(owner.id);
  }, [pathname, projects, setOpenProject]);

  useEffect(() => {
    function onMove(e: PointerEvent) {
      const drag = dragRef.current;
      if (!drag) return;
      const raw = drag.startW + (e.clientX - drag.startX);
      // No floor clamp above the collapse threshold — the rail keeps
      // shrinking continuously (1:1 with the pointer) right up to the
      // collapse point instead of getting stuck at RAIL_MIN_WIDTH, so
      // there's no dead zone before it gives way.
      const next = raw < RAIL_COLLAPSE_THRESHOLD ? RAIL_COLLAPSED_WIDTH : Math.min(RAIL_MAX_WIDTH, raw);
      const prevW = useAppShellStore.getState().railW;
      // Crossing into/out of fully-collapsed is the one point where the
      // width jumps instead of tracking the cursor — let just that jump
      // ease in via a brief transition instead of teleporting mid-drag.
      if (next !== prevW && (next === RAIL_COLLAPSED_WIDTH || prevW === RAIL_COLLAPSED_WIDTH)) {
        setRailSnapping(true);
        if (snapTimeoutRef.current !== null) window.clearTimeout(snapTimeoutRef.current);
        snapTimeoutRef.current = window.setTimeout(() => setRailSnapping(false), 200);
      }
      setRailW(next);
    }
    function onUp() {
      if (dragRef.current) {
        dragRef.current = null;
        setRailDrag(false);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (snapTimeoutRef.current !== null) window.clearTimeout(snapTimeoutRef.current);
    };
  }, [setRailW, setRailDrag]);

  function handleRailPointerDown(e: ReactPointerEvent) {
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startW: railW };
    setRailDrag(true);
    // Dragging across nav labels/links would otherwise start a text
    // selection and let the cursor flicker between col-resize and
    // whatever the pointer happens to be over — pin both for the
    // duration of the drag so the resize itself feels uninterrupted.
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }

  function handleRailDoubleClick(e: ReactMouseEvent) {
    e.stopPropagation();
    toggleRailCollapse();
  }

  // Active for the list page and anything nested under it (project detail,
  // workflow canvas) — mirrors the design's `n.id==='projects' &&
  // (s.page==='project'||s.page==='automation')` active clause.
  const isProjectsNavActive = pathname === '/app/projects' || pathname.startsWith('/app/projects/') || pathname.startsWith('/app/workflows/');
  const canManageOrg = role === 'admin' || role === 'owner';
  // Matches the design's `canBilling: !orgMember` — individual, admin and
  // owner see Billing; member does not. (Separate from the server-side
  // billing.view capability in packages/schemas/src/can.ts, which is a
  // deeper permission check, not sidebar-visibility.)
  const canBilling = role !== 'member';
  // Subscription Phase 2, Slice 7: members.view includes plain members
  // (read-only there), excludes viewer/individual — matches
  // packages/schemas/src/can.ts's CAPABILITY_MATRIX exactly, unlike
  // canManageOrg above (admin/owner only) which the old placeholder used.
  const canViewMembers = can(role, 'members.view');
  // Slice L3 (agent-canvas-integration.md B.1) — agents.view includes every
  // role (viewer too); kept as an explicit gate for defense-in-depth
  // consistency with the rest of this file, not because it ever hides this.
  const canViewAgents = can(role, 'agents.view');
  // Viewer is read-only everywhere (0057_viewer_role_restrictions.sql)
  // — hide the one write control this sidebar renders.
  const canWrite = role !== 'viewer';

  return (
    <nav style={navRailStyle(railW, railDrag && !railSnapping, wide)} aria-label="Primary">
      <div
        onPointerDown={handleRailPointerDown}
        onDoubleClick={handleRailDoubleClick}
        title="Drag to resize \u00b7 double-click to toggle"
        style={navRailHandleStyle(railDrag)}
      />

      <div style={navRailScrollStyle(wide)}>
        {canManageOrg && (
          <button
            type="button"
            className="nx-wipe nx-row-disabled"
            style={navRailBtnStyle(wide)}
            disabled
            aria-label="Org dashboard \u2014 soon"
            title={wide ? 'Org dashboard \u2014 soon' : undefined}
            onMouseEnter={(e) => showHoverLabel(e, 'Org dashboard \u2014 soon')}
            onMouseLeave={hideHoverLabel}
            onFocus={(e) => showHoverLabel(e, 'Org dashboard \u2014 soon')}
            onBlur={hideHoverLabel}
          >
            <NxDashboardIcon size={20} />
            {wide && (
              <>
                <span style={navRailBtnLabelStyle}>Org dashboard</span>
                <span style={navRailSoonMetaStyle}>SOON</span>
              </>
            )}
          </button>
        )}

        <a
          href="/app"
          className={`nx-wipe${pathname === '/app' ? ' nx-active-cell' : ''}`}
          style={{ ...navRailBtnStyle(wide), textDecoration: 'none' }}
          aria-label="Home"
          title={wide ? 'Home' : undefined}
          onMouseEnter={(e) => showHoverLabel(e, 'Home')}
          onMouseLeave={hideHoverLabel}
          onFocus={(e) => showHoverLabel(e, 'Home')}
          onBlur={hideHoverLabel}
        >
          <NxHomeIcon size={20} />
          {wide && <span style={navRailBtnLabelStyle}>Home</span>}
        </a>

        {wide && <div style={navGroupLabelStyle}>Projects</div>}

        <Link
          href="/app/projects"
          onClick={toggleNavProjectsOpen}
          className={`nx-wipe${isProjectsNavActive ? ' nx-active-cell' : ''}`}
          style={{ ...navRailBtnStyle(wide), textDecoration: 'none' }}
          aria-label="Projects"
          title={wide ? 'Projects' : undefined}
          onMouseEnter={(e) => showHoverLabel(e, 'Projects')}
          onMouseLeave={hideHoverLabel}
          onFocus={(e) => showHoverLabel(e, 'Projects')}
          onBlur={hideHoverLabel}
        >
          <NxProjectsIcon size={20} />
          {wide && <span style={{ ...navRailBtnLabelStyle, flex: 1 }}>Projects</span>}
          {wide && (
            <span
              aria-hidden
              style={{
                flex: 'none',
                display: 'flex',
                transform: navProjectsOpen ? 'rotate(90deg)' : 'none',
                transition: 'transform .16s ease',
              }}
            >
              <NxChevronRightIcon size={12} />
            </span>
          )}
        </Link>

        {wide && navProjectsOpen && (
          <div style={projectsNestStyle}>
            {projects.map((project) => {
              const isOpen = openProject === project.id;
              const isActiveProject = pathname === `/app/projects/${project.id}`;
              return (
                <div key={project.id}>
                  <Link
                    href={`/app/projects/${project.id}`}
                    onClick={() => toggleOpenProject(project.id)}
                    style={{ ...projectRowStyle(isActiveProject), textDecoration: 'none' }}
                  >
                    <span aria-hidden style={projectChevronStyle(isOpen)}>{'\u203A'}</span>
                    <span style={treeLabelStyle}>{project.name}</span>
                  </Link>
                  {isOpen &&
                    project.workflows.map((workflow) => {
                      const isActiveWorkflow = pathname === `/app/workflows/${workflow.id}`;
                      return (
                        <Link
                          key={workflow.id}
                          href={`/app/workflows/${workflow.id}`}
                          style={{ ...workflowRowStyle(isActiveWorkflow), textDecoration: 'none' }}
                        >
                          <span
                            role="img"
                            aria-label={navTreeStatusLabel(workflow.status)}
                            style={navTreeStatusDotStyle(workflow.status, isActiveWorkflow)}
                          />
                          <span style={treeLabelStyle}>{workflow.name}</span>
                        </Link>
                      );
                    })}
                </div>
              );
            })}
            {canWrite && (
              <button type="button" style={newProjectRowStyle} onClick={() => setShowCreateProject(true)}>
                + New project
              </button>
            )}
          </div>
        )}

        {wide && <div style={navGroupLabelStyle}>Platform</div>}

        <a
          href="/app/connections"
          className={`nx-wipe${pathname === '/app/connections' ? ' nx-active-cell' : ''}`}
          style={{ ...navRailBtnStyle(wide), textDecoration: 'none' }}
          aria-label="Connections"
          title={wide ? 'Connections' : undefined}
          onMouseEnter={(e) => showHoverLabel(e, 'Connections')}
          onMouseLeave={hideHoverLabel}
          onFocus={(e) => showHoverLabel(e, 'Connections')}
          onBlur={hideHoverLabel}
        >
          <NxConnectionsIcon size={20} />
          {wide && <span style={navRailBtnLabelStyle}>Connections</span>}
        </a>

        {canViewMembers && (
          <a
            href="/app/members"
            className={`nx-wipe${pathname === '/app/members' ? ' nx-active-cell' : ''}`}
            style={{ ...navRailBtnStyle(wide), textDecoration: 'none' }}
            aria-label="Members & roles"
            title={wide ? 'Members & roles' : undefined}
            onMouseEnter={(e) => showHoverLabel(e, 'Members & roles')}
            onMouseLeave={hideHoverLabel}
            onFocus={(e) => showHoverLabel(e, 'Members & roles')}
            onBlur={hideHoverLabel}
          >
            <NxMembersIcon size={20} />
            {wide && <span style={navRailBtnLabelStyle}>Members & roles</span>}
          </a>
        )}

        {canViewAgents && (
          <a
            href="/app/agents"
            className={`nx-wipe${pathname === '/app/agents' ? ' nx-active-cell' : ''}`}
            style={{ ...navRailBtnStyle(wide), textDecoration: 'none' }}
            aria-label="Agents"
            title={wide ? 'Agents' : undefined}
            onMouseEnter={(e) => showHoverLabel(e, 'Agents')}
            onMouseLeave={hideHoverLabel}
            onFocus={(e) => showHoverLabel(e, 'Agents')}
            onBlur={hideHoverLabel}
          >
            <NxAgentsIcon size={20} />
            {wide && <span style={navRailBtnLabelStyle}>Agents</span>}
          </a>
        )}

      </div>

      <div style={navRailFooterStyle()}>
        <Link
          href="/app/settings"
          className={`nx-wipe${pathname === '/app/settings' ? ' nx-active-cell' : ''}`}
          style={{ ...navRailBtnStyle(wide), textDecoration: 'none' }}
          aria-label="Settings"
          title={wide ? 'Settings' : undefined}
          onMouseEnter={(e) => showHoverLabel(e, 'Settings')}
          onMouseLeave={hideHoverLabel}
          onFocus={(e) => showHoverLabel(e, 'Settings')}
          onBlur={hideHoverLabel}
        >
          <NxSettingsIcon size={20} />
          {wide && <span style={navRailBtnLabelStyle}>Settings</span>}
        </Link>

        {canBilling && (
          <a
            href="/app/billing"
            className={`nx-wipe${pathname === '/app/billing' ? ' nx-active-cell' : ''}`}
            style={{ ...navRailBtnStyle(wide), textDecoration: 'none' }}
            aria-label="Billing"
            title={wide ? 'Billing' : undefined}
            onMouseEnter={(e) => showHoverLabel(e, 'Billing')}
            onMouseLeave={hideHoverLabel}
            onFocus={(e) => showHoverLabel(e, 'Billing')}
            onBlur={hideHoverLabel}
          >
            <NxBillingIcon size={20} />
            {wide && <span style={navRailBtnLabelStyle}>Billing</span>}
          </a>
        )}

        <button
          type="button"
          className="nx-wipe"
          style={navRailExpandToggleStyle}
          onClick={toggleRailCollapse}
          aria-label={wide ? 'Collapse sidebar' : 'Expand sidebar'}
          title={wide ? undefined : 'Expand sidebar'}
          onMouseEnter={(e) => showHoverLabel(e, wide ? 'Collapse sidebar' : 'Expand sidebar')}
          onMouseLeave={hideHoverLabel}
          onFocus={(e) => showHoverLabel(e, wide ? 'Collapse sidebar' : 'Expand sidebar')}
          onBlur={hideHoverLabel}
        >
          <span aria-hidden style={{ display: 'flex', transform: wide ? undefined : 'scaleX(-1)' }}>
            <NxCollapseIcon size={14} />
          </span>
          {wide && <span>Collapse</span>}
        </button>
      </div>

      {!wide && hoverLabel && (
        <span
          role="tooltip"
          style={{
            position: 'fixed',
            top: hoverLabel.top,
            left: hoverLabel.left,
            transform: 'translateY(-50%)',
            height: 32,
            boxSizing: 'border-box',
            display: 'flex',
            alignItems: 'center',
            padding: '0 10px',
            background: 'var(--nx-ink)',
            color: 'var(--nx-bg)',
            fontSize: 13,
            borderRadius: 'var(--nx-radius)',
            whiteSpace: 'nowrap',
            zIndex: 200,
            pointerEvents: 'none',
          }}
        >
          {hoverLabel.text}
        </span>
      )}

      {showCreateProject && <CreateProjectDialog orgId={orgId} onClose={() => setShowCreateProject(false)} />}
      {showCreateWorkflow && (
        <CreateWorkflowDialog orgId={orgId} projects={projects} onClose={() => setShowCreateWorkflow(false)} />
      )}
    </nav>
  );
}
