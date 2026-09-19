'use client';

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type MouseEvent as ReactMouseEvent } from 'react';
import { usePathname } from 'next/navigation';
import type { SidebarProject } from '@/lib/dashboard/types';
import type { ActorRole } from '@nia/schemas';
import { logout } from '@/lib/auth/actions';
import Logo from '@/components/Logo';
import {
  dropdownItemStyle,
  dropdownStyleUp,
  settingsEmailRowStyle,
  sidebarUserAvatarStyle,
} from '@/components/app/styles';
import CreateProjectDialog from '@/components/app/CreateProjectDialog';
import CreateWorkflowDialog from '@/components/app/CreateWorkflowDialog';
import {
  ICON_RAIL_COLLAPSE_THRESHOLD,
  ICON_RAIL_WIDTH_COLLAPSED,
  ICON_RAIL_WIDTH_EXPANDED,
  iconRailBtnLabelStyle,
  iconRailBtnStyle,
  iconRailExpandToggleStyle,
  iconRailFooterStyle,
  iconRailHandleStyle,
  iconRailScrollStyle,
  iconRailStyle,
} from './styles';
import {
  BillingIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ConnectionsIcon,
  HomeIcon,
  PlusIcon,
  ProjectsIcon,
  SettingsIcon,
} from './navIcons';

/**
 * Icon rail for the workflow canvas route only (per the canvas redesign —
 * designs/canvasredesign.html). Sibling of FlowCanvas at the page level
 * (apps/web/src/app/app/workflows/[id]/page.tsx), NOT a replacement for the
 * shared apps/web/src/components/app/Sidebar.tsx used by every other
 * /app/* route — that file is intentionally untouched. Every action here
 * reuses existing logic (CreateProjectDialog/CreateWorkflowDialog, the
 * `logout` server action) — no new handlers.
 *
 * `railW` (UI feedback: "left sidebar isn't draggable") is session-only local
 * state, no persistence: collapsed (56px, icons only) is the default, drag
 * the right-edge handle to resize live (mirrors app/Sidebar.tsx's railW
 * pattern), or use the footer chevron button to jump straight to expanded
 * (200px, icon + label per row + wordmark on the brand mark). `expanded` is
 * derived from `railW` crossing `ICON_RAIL_COLLAPSE_THRESHOLD`.
 */
export default function CanvasIconRail({
  orgId,
  role,
  projects,
  email,
}: {
  orgId: string | null;
  role: ActorRole;
  projects: SidebarProject[];
  email: string;
}) {
  const pathname = usePathname();
  const [railW, setRailW] = useState(ICON_RAIL_WIDTH_COLLAPSED);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ startX: number; startW: number } | null>(null);
  const [showCreateMenu, setShowCreateMenu] = useState(false);
  const [showCreateProject, setShowCreateProject] = useState(false);
  const [showCreateWorkflow, setShowCreateWorkflow] = useState(false);
  const [showSettingsMenu, setShowSettingsMenu] = useState(false);

  const expanded = railW > ICON_RAIL_COLLAPSE_THRESHOLD;
  const canBilling = role !== 'member';
  const initials = email.slice(0, 2).toUpperCase();

  useEffect(() => {
    function onMove(e: PointerEvent) {
      const drag = dragRef.current;
      if (!drag) return;
      const raw = drag.startW + (e.clientX - drag.startX);
      const next = raw < ICON_RAIL_COLLAPSE_THRESHOLD ? ICON_RAIL_WIDTH_COLLAPSED : Math.min(ICON_RAIL_WIDTH_EXPANDED, raw);
      setRailW(next);
    }
    function onUp() {
      if (dragRef.current) {
        dragRef.current = null;
        setDragging(false);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, []);

  function handleRailPointerDown(e: ReactPointerEvent) {
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startW: railW };
    setDragging(true);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }

  function handleRailDoubleClick(e: ReactMouseEvent) {
    e.stopPropagation();
    setRailW((w) => (w > ICON_RAIL_COLLAPSE_THRESHOLD ? ICON_RAIL_WIDTH_COLLAPSED : ICON_RAIL_WIDTH_EXPANDED));
  }

  return (
    <nav style={iconRailStyle(railW, dragging)} aria-label="Primary">
      <div
        onPointerDown={handleRailPointerDown}
        onDoubleClick={handleRailDoubleClick}
        title="Drag to resize \u00b7 double-click to toggle"
        style={iconRailHandleStyle(dragging)}
      />
      <div style={{ padding: expanded ? '0 8px 12px' : '0 0 12px', display: 'flex' }}>
        <Logo size={24} showWordmark={expanded} />
      </div>

      <div style={{ position: 'relative', width: expanded ? '100%' : 'auto' }}>
        <button
          type="button"
          style={iconRailBtnStyle(showCreateMenu, expanded)}
          onClick={() => setShowCreateMenu((v) => !v)}
          aria-label="New"
          title="New workflow or project"
        >
          <PlusIcon size={16} />
          {expanded && <span style={iconRailBtnLabelStyle}>New</span>}
        </button>
        {showCreateMenu && (
          <div style={{ ...dropdownStyleUp, left: expanded ? 8 : 44, top: 'auto', bottom: 0, minWidth: 196 }} onMouseLeave={() => setShowCreateMenu(false)}>
            <button
              type="button"
              style={dropdownItemStyle}
              onClick={() => {
                setShowCreateMenu(false);
                setShowCreateProject(true);
              }}
            >
              New project
            </button>
            <button
              type="button"
              style={dropdownItemStyle}
              onClick={() => {
                setShowCreateMenu(false);
                setShowCreateWorkflow(true);
              }}
            >
              New workflow
            </button>
          </div>
        )}
      </div>

      <div style={iconRailScrollStyle}>
        <a href="/app" style={{ ...iconRailBtnStyle(pathname === '/app', expanded), textDecoration: 'none' }} aria-label="Home" title="Home">
          <HomeIcon size={16} />
          {expanded && <span style={iconRailBtnLabelStyle}>Home</span>}
        </a>

        <a
          href="/app/projects"
          style={{
            ...iconRailBtnStyle(pathname === '/app/projects' || pathname.startsWith('/app/projects/') || pathname.startsWith('/app/workflows/'), expanded),
            textDecoration: 'none',
          }}
          aria-label="Projects"
          title="Projects"
        >
          <ProjectsIcon size={16} />
          {expanded && <span style={iconRailBtnLabelStyle}>Projects</span>}
        </a>

        <a
          href="/app/connections"
          style={{ ...iconRailBtnStyle(pathname === '/app/connections', expanded), textDecoration: 'none' }}
          aria-label="Connections"
          title="Connections"
        >
          <ConnectionsIcon size={16} />
          {expanded && <span style={iconRailBtnLabelStyle}>Connections</span>}
        </a>
      </div>

      <div style={iconRailFooterStyle}>
        {canBilling && (
          <a
            href="/app/billing"
            style={{ ...iconRailBtnStyle(pathname === '/app/billing', expanded), textDecoration: 'none' }}
            aria-label="Billing"
            title="Billing"
          >
            <BillingIcon size={16} />
            {expanded && <span style={iconRailBtnLabelStyle}>Billing</span>}
          </a>
        )}

        <div style={{ position: 'relative', width: expanded ? '100%' : 'auto' }}>
          <button
            type="button"
            style={iconRailBtnStyle(showSettingsMenu, expanded)}
            onClick={() => setShowSettingsMenu((v) => !v)}
            aria-label="Settings"
            title="Settings"
          >
            <SettingsIcon size={16} />
            {expanded && <span style={iconRailBtnLabelStyle}>Settings</span>}
          </button>
          {showSettingsMenu && (
            <div style={{ ...dropdownStyleUp, left: expanded ? 8 : 44, bottom: 0 }} onMouseLeave={() => setShowSettingsMenu(false)}>
              <div style={settingsEmailRowStyle}>{email}</div>
            </div>
          )}
        </div>

        <form action={logout} style={{ width: expanded ? '100%' : 'auto' }}>
          <button
            type="submit"
            style={{
              ...sidebarUserAvatarStyle,
              cursor: 'pointer',
              border: 'none',
              fontFamily: 'inherit',
              ...(expanded ? { width: '100%', borderRadius: 8, justifyContent: 'flex-start', gap: 8, paddingLeft: 8 } : {}),
            }}
            title="Sign out"
          >
            {initials}
            {expanded && <span style={iconRailBtnLabelStyle}>Sign out</span>}
          </button>
        </form>

        <button
          type="button"
          style={iconRailExpandToggleStyle}
          onClick={() => setRailW(expanded ? ICON_RAIL_WIDTH_COLLAPSED : ICON_RAIL_WIDTH_EXPANDED)}
          aria-label={expanded ? 'Collapse sidebar' : 'Expand sidebar'}
          title={expanded ? 'Collapse sidebar' : 'Expand sidebar'}
        >
          {expanded ? <ChevronLeftIcon size={14} /> : <ChevronRightIcon size={14} />}
          {expanded && <span>Collapse</span>}
        </button>
      </div>

      {showCreateProject && <CreateProjectDialog orgId={orgId} onClose={() => setShowCreateProject(false)} />}
      {showCreateWorkflow && (
        <CreateWorkflowDialog orgId={orgId} projects={projects} onClose={() => setShowCreateWorkflow(false)} />
      )}
    </nav>
  );
}
