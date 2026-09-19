'use client';

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type MouseEvent as ReactMouseEvent } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { SidebarProject } from '@/lib/dashboard/types';
import type { ActorRole } from '@nia/schemas';
import {
  createWorkflowBtnStyle,
  dropdownItemStyle,
  dropdownStyle,
  dropdownStyleUp,
  navChevronStyle,
  navGroupLabelStyle,
  navItemStyle,
  navScrollStyle,
  newProjectRowStyle,
  projectChevronStyle,
  projectRowStyle,
  projectsNestStyle,
  projectsParentRowStyle,
  railHandleStyle,
  RAIL_COLLAPSE_THRESHOLD,
  RAIL_COLLAPSED_WIDTH,
  RAIL_MAX_WIDTH,
  RAIL_MIN_WIDTH,
  settingsEmailRowStyle,
  sidebarFooterStyle,
  sidebarStyle,
  sidebarUserAvatarStyle,
  sidebarUserEmailStyle,
  sidebarUserRoleStyle,
  sidebarUserRowStyle,
  sidebarUserTextColStyle,
  statusDotStyle,
  treeLabelStyle,
  workflowRowStyle,
} from './styles';
import { useAppShellStore } from './store';
import CreateProjectDialog from './CreateProjectDialog';
import CreateWorkflowDialog from './CreateWorkflowDialog';

// Nav structure mirrors designs/Nia Core App.html's `NAV` array exactly:
// Org dashboard, Home, Projects (tree), Platform group (Connections,
// Members & roles, Audit log). "Run history" / "Recently deleted" only
// live in the design's command palette, never in this sidebar.
// Org dashboard / Members & roles / Audit log pages are Step 3 work not
// yet built, so — like the design's own "soon"-suffixed demo items — they
// render disabled for now; Connections and Billing already have real
// pages so those are live links.
const ROLE_LABEL: Record<ActorRole, string> = {
  individual: 'Individual',
  member: 'Member',
  admin: 'Admin',
  owner: 'Owner',
};

export default function Sidebar({
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
  const [showCreateMenu, setShowCreateMenu] = useState(false);
  const [showSettingsMenu, setShowSettingsMenu] = useState(false);
  const [railSnapping, setRailSnapping] = useState(false);
  const dragRef = useRef<{ startX: number; startW: number } | null>(null);
  const snapTimeoutRef = useRef<number | null>(null);

  // wide/narrow mirrors the design's `get wide(){ return railW >= 168 }` —
  // below that threshold the rail shows icon-only rows, same visual result
  // as the old boolean `collapsed` state but now driven by a live width.
  const wide = railW >= RAIL_MIN_WIDTH;

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
  const initials = email.slice(0, 2).toUpperCase();

  return (
    <nav style={sidebarStyle(railW, railDrag && !railSnapping)} aria-label="Primary">
      <div style={{ position: 'relative', margin: '14px 14px 12px' }}>
        <button
          type="button"
          style={{ ...createWorkflowBtnStyle, margin: 0, width: '100%' }}
          onClick={() => setShowCreateMenu((v) => !v)}
        >
          <span aria-hidden>+</span>
          {wide && <span>New workflow</span>}
        </button>
        {showCreateMenu && (
          <div style={{ ...dropdownStyle, left: 0, minWidth: 196 }} onMouseLeave={() => setShowCreateMenu(false)}>
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

      <div style={navScrollStyle}>
        {canManageOrg && (
          <button
            type="button"
            style={{ ...navItemStyle(false, wide), color: 'var(--text-4)', cursor: 'default' }}
            disabled
            title={wide ? undefined : 'Org dashboard \u2014 soon'}
          >
            <span aria-hidden>{'\u25D1'}</span>
            {wide && <span>Org dashboard {'\u2014'} soon</span>}
          </button>
        )}

        <a
          href="/app"
          style={{ ...navItemStyle(pathname === '/app', wide), textDecoration: 'none', display: 'flex' }}
          title={wide ? undefined : 'Home'}
        >
          <span aria-hidden>{'\u2302'}</span>
          {wide && <span>Home</span>}
        </a>

        {wide && <div style={navGroupLabelStyle}>Projects</div>}

        <Link
          href="/app/projects"
          onClick={toggleNavProjectsOpen}
          style={{ ...projectsParentRowStyle(isProjectsNavActive, wide), textDecoration: 'none' }}
          title={wide ? undefined : 'Projects'}
        >
          <span aria-hidden style={{ fontSize: 13, color: 'var(--text-3)' }}>{'\u25A4'}</span>
          {wide && <span style={{ flex: 1 }}>Projects</span>}
          {wide && <span aria-hidden style={navChevronStyle(navProjectsOpen)}>{'\u203A'}</span>}
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
                          <span style={{ ...statusDotStyle(workflow.status), width: 6, height: 6 }} aria-hidden />
                          <span style={treeLabelStyle}>{workflow.name}</span>
                        </Link>
                      );
                    })}
                </div>
              );
            })}
            <button type="button" style={newProjectRowStyle} onClick={() => setShowCreateProject(true)}>
              + New project
            </button>
          </div>
        )}

        {wide && <div style={navGroupLabelStyle}>Platform</div>}
        <a
          href="/app/connections"
          style={{ ...navItemStyle(pathname === '/app/connections', wide), textDecoration: 'none', display: 'flex' }}
          title={wide ? undefined : 'Connections'}
        >
          <span aria-hidden style={{ fontSize: 13, color: 'var(--text-3)' }}>{'\u25A6'}</span>
          {wide && <span>Connections</span>}
        </a>

        {canManageOrg && (
          <button
            type="button"
            style={{ ...navItemStyle(false, wide), color: 'var(--text-4)', cursor: 'default' }}
            disabled
            title={wide ? undefined : 'Members & roles \u2014 soon'}
          >
            <span aria-hidden>{'\u2687'}</span>
            {wide && <span>Members & roles {'\u2014'} soon</span>}
          </button>
        )}

        {canManageOrg && (
          <button
            type="button"
            style={{ ...navItemStyle(false, wide), color: 'var(--text-4)', cursor: 'default' }}
            disabled
            title={wide ? undefined : 'Audit log \u2014 soon'}
          >
            <span aria-hidden>{'\u2261'}</span>
            {wide && <span>Audit log {'\u2014'} soon</span>}
          </button>
        )}
      </div>

      <div
        onPointerDown={handleRailPointerDown}
        onDoubleClick={handleRailDoubleClick}
        title="Drag to resize \u00b7 drag further to collapse"
        style={railHandleStyle(railDrag)}
      />

      <div style={sidebarFooterStyle}>
        {canBilling && (
          <a
            href="/app/billing"
            style={{ ...navItemStyle(pathname === '/app/billing', wide), textDecoration: 'none', display: 'flex' }}
            title={wide ? undefined : 'Billing'}
          >
            <span aria-hidden>{'\u25AD'}</span>
            {wide && <span>Billing</span>}
          </a>
        )}

        <div style={{ position: 'relative' }}>
          <button
            type="button"
            style={navItemStyle(false, wide)}
            onClick={() => setShowSettingsMenu((v) => !v)}
            title={wide ? undefined : 'Settings'}
          >
            <span aria-hidden>{'\u2699'}</span>
            {wide && <span>Settings</span>}
          </button>
          {showSettingsMenu && (
            <div style={dropdownStyleUp} onMouseLeave={() => setShowSettingsMenu(false)}>
              <div style={settingsEmailRowStyle}>{email}</div>
            </div>
          )}
        </div>

        <div style={sidebarUserRowStyle(wide)} title={wide ? undefined : `${email} \u00b7 ${ROLE_LABEL[role]}`}>
          <span style={sidebarUserAvatarStyle} aria-hidden>{initials}</span>
          {wide && (
            <span style={sidebarUserTextColStyle}>
              <span style={sidebarUserEmailStyle}>{email}</span>
              <span style={sidebarUserRoleStyle}>{ROLE_LABEL[role]}</span>
            </span>
          )}
        </div>
      </div>

      {showCreateProject && <CreateProjectDialog orgId={orgId} onClose={() => setShowCreateProject(false)} />}
      {showCreateWorkflow && (
        <CreateWorkflowDialog orgId={orgId} projects={projects} onClose={() => setShowCreateWorkflow(false)} />
      )}
    </nav>
  );
}
