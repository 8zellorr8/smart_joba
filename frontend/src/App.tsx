import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { api, ApiError } from "./api";
import type { Role, Session, User, Workspace } from "./api";
import { Icon } from "./icons";
import { messages as t } from "./locales/kk";
import { ImportPage } from "./ImportPage";
import { CalendarPage } from "./CalendarPage";
import { EditorPage } from "./EditorPage";
import { PlanningPage } from "./PlanningPage";
import { VersionsPage } from "./VersionsPage";
import { PublicationsPage } from "./PublicationsPage";
import { vm } from "./locales/publication.kk";
import { pm } from "./locales/planning.kk";
import { wb } from "./locales/workbench.kk";
import { WorkbenchHome } from "./WorkbenchHome";
import { SubjectsPage, subjectsLabel } from "./SubjectOverview";
import { portal } from "./locales/portal.kk";

type Screen = "loading" | "login" | "workspace" | "error";
const roleNames: Record<Role, string> = {
  admin: t.roleAdmin,
  scheduler: t.roleScheduler,
  approver: t.roleApprover,
  teacher: t.roleTeacher,
  student: t.roleStudent,
};
const permissionNames: Record<string, string> = {
  "accounts.prepare": "Аккаунттарды дайындау",
  "catalog.manage": "Анықтамалықтарды басқару",
  "calendar.manage": "Оқу күнтізбесін басқару",
  "import.source.read": "Бастапқы деректерді қарау",
  "import.write": "Деректерді импорттау",
  "draft.read": "Кесте жобасын қарау",
  "draft.edit": "Кесте жобасын өңдеу",
  "generator.run": "Кестені автоматты құрастыру",
  "draft.submit": "Жобаны келісуге жіберу",
  "draft.approve": "Кесте жобасын бекіту",
  "draft.reject": "Жобаны түзетуге қайтару",
  "draft.publish": "Бекітілген кестені жариялау",
  "publication.read": "Жарияланған кестені қарау",
  "publication.export": "Жарияланған кестені жүктеу",
  "publication.read.own": "Өз сабақ кестесін қарау",
  "publication.export.own": "Өз сабақ кестесін жүктеу",
  "publication.read.group": "Өз тобының кестесін қарау",
  "publication.export.group": "Өз тобының кестесін жүктеу",
};

function errorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return t.serverError;
  if (error.status === 0) return t.connectionError;
  if (error.status === 429) return t.rateLimited;
  if (error.code === "AUTH_INVALID_CREDENTIALS") return t.invalidCredentials;
  if (error.code === "CSRF_INVALID") return t.sessionError;
  if (error.status === 403) return t.noAccess;
  return t.serverError;
}

function Brand({
  inverse = false,
  compact = false,
}: {
  inverse?: boolean;
  compact?: boolean;
}) {
  return (
    <div className={`brand ${inverse ? "brand--inverse" : ""}`}>
      <span className="brand-mark">
        <img src="/favicon.svg?v=2" alt="" width="47" height="47" />
      </span>
      <span>
        <strong>{t.appName}</strong>
        <span className="brand-caption">
          {compact ? portal.title : t.appDescription}
        </span>
      </span>
    </div>
  );
}

function Login({
  session,
  notice,
  onSuccess,
  onRefresh,
}: {
  session: Session;
  notice: string;
  onSuccess: (session: Session) => Promise<void>;
  onRefresh: () => Promise<void>;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [invalid, setInvalid] = useState(false);
  const passwordRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (error && !busy) passwordRef.current?.focus();
  }, [error, busy]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    setInvalid(false);
    try {
      const result = await api.login(
        email.trim(),
        password,
        session.csrf_token,
      );
      setPassword("");
      await onSuccess(result);
    } catch (problem) {
      setPassword("");
      setVisible(false);
      setError(errorMessage(problem));
      setInvalid(
        problem instanceof ApiError &&
          problem.code === "AUTH_INVALID_CREDENTIALS",
      );
      if (problem instanceof ApiError && problem.code === "CSRF_INVALID") {
        try {
          await onRefresh();
        } catch {
          setError(t.connectionError);
        }
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-layout">
      <aside className="login-story" aria-label={t.appDescription}>
        <Brand inverse />
        <div className="story-content">
          <p className="eyebrow story-eyebrow">{t.loginEyebrow}</p>
          <h1>{t.loginTitle}</h1>
          <p className="story-intro">{t.loginDescription}</p>
          <div className="story-steps">
            {(
              [
                ["file", t.featureData, t.featureDataBody],
                ["calendar", t.featureSchedule, t.featureScheduleBody],
                ["layers", t.featurePublish, t.featurePublishBody],
              ] as const
            ).map(([icon, title, body], i) => (
              <div className="story-step" key={title}>
                <span className="story-step-icon">
                  <Icon name={icon} size={23} />
                </span>
                <div>
                  <strong>{title}</strong>
                  <p>{body}</p>
                </div>
                <span className="step-number">0{i + 1}</span>
              </div>
            ))}
          </div>
          <p className="story-roadmap">{t.roadmapHint}</p>
        </div>
        <span className="story-footer">
          <span className="local-dot" />
          {t.local}
        </span>
        <div className="story-decoration" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
      </aside>
      <main id="main" className="login-main">
        <div className="login-top">
          <span className="mobile-brand">
            <img src="/favicon.svg?v=2" alt="" width="32" height="32" />
            {t.appName}
          </span>
          <span className="language-label">
            Ққ <span>{t.language}</span>
          </span>
        </div>
        <div className="login-form-wrap">
          <span className="form-emblem">
            <Icon name="lock" size={25} />
          </span>
          <h2>{t.signInTitle}</h2>
          <p className="form-description">{t.signInDescription}</p>
          {notice && (
            <p className="notice" role="status">
              {notice}
            </p>
          )}
          <form onSubmit={submit} aria-busy={busy}>
            <div className="field">
              <label htmlFor="email">{t.email}</label>
              <input
                id="email"
                name="email"
                type="email"
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={t.emailPlaceholder}
                required
                disabled={busy}
                aria-invalid={invalid}
                aria-describedby={error ? "login-error" : undefined}
              />
            </div>
            <div className="field">
              <label htmlFor="password">{t.password}</label>
              <div className="password-control">
                <input
                  ref={passwordRef}
                  id="password"
                  name="password"
                  type={visible ? "text" : "password"}
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  disabled={busy}
                  aria-invalid={invalid}
                  aria-describedby={error ? "login-error" : undefined}
                />
                <button
                  className="password-toggle"
                  type="button"
                  onClick={() => setVisible((v) => !v)}
                  aria-label={visible ? t.hidePassword : t.showPassword}
                  aria-pressed={visible}
                  disabled={busy}
                >
                  <Icon name={visible ? "eyeOff" : "eye"} size={21} />
                </button>
              </div>
            </div>
            <div className="form-message" aria-live="polite" aria-atomic="true">
              {error && (
                <p className="error-message" id="login-error">
                  <Icon name="alert" size={19} />
                  <span>{error}</span>
                </p>
              )}
            </div>
            <button
              type="submit"
              className="button button-primary login-submit"
              disabled={busy}
            >
              {busy ? (
                <>
                  <span className="spinner" />
                  {t.signingIn}
                </>
              ) : (
                <>
                  {t.signIn}
                  <Icon name="arrow" size={20} />
                </>
              )}
            </button>
          </form>
          <p className="account-help">{t.accountHelp}</p>
          <div className="secure-caption">
            <Icon name="lock" size={15} />
            {t.secureSession}
          </div>
        </div>
        <footer className="login-footer">
          <span>{t.footer}</span>
        </footer>
      </main>
    </div>
  );
}

function WorkspaceScreen({
  user,
  workspace,
  onLogout,
  busy,
  error,
  csrfToken,
  onExpired,
}: {
  user: User;
  workspace: Workspace;
  onLogout: () => Promise<void>;
  busy: boolean;
  error: string;
  csrfToken: string;
  onExpired: () => void;
}) {
  const [view, setViewState] = useState<
    | "overview"
    | "subjects"
    | "import"
    | "calendar"
    | "editor"
    | "planning"
    | "versions"
    | "publications"
  >("overview");
  const [publicationFocus, setPublicationFocus] = useState<string>();
  const [publicationGroup, setPublicationGroup] = useState("");
  const [publicationDate, setPublicationDate] = useState<string>();
  const [planningDirty, setPlanningDirty] = useState(false);
  const navigationDialog = useRef<HTMLDialogElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [subjectFocus, setSubjectFocus] = useState("");
  const [subjectVisit, setSubjectVisit] = useState(0);
  function setView(next: typeof view) {
    if (
      (view === "planning" || view === "versions") &&
      next !== view &&
      planningDirty &&
      !window.confirm(pm.leaveDirty)
    )
      return;
    if (next !== view) setPlanningDirty(false);
    setViewState(next);
    if (navigationDialog.current?.open) navigationDialog.current.close();
    requestAnimationFrame(() => document.getElementById("main")?.focus());
  }
  const [editorDraftId, setEditorDraftId] = useState<string | undefined>();
  const [versionFocus, setVersionFocus] = useState<string | undefined>();
  const activeRoles = workspace.role_codes;
  const isReader =
    activeRoles.length > 0 &&
    activeRoles.every((r) => r === "student" || r === "teacher");
  const nextDescription = isReader
    ? t.noPublishedBody
    : activeRoles.includes("scheduler")
      ? t.nextStepDescription
      : activeRoles.includes("admin")
        ? t.nextAdminDescription
        : t.nextApproverDescription;
  const canReadCalendar =
    workspace.permissions.includes("calendar.manage") ||
    workspace.permissions.includes("draft.read");
  const canReadEditor =
    workspace.permissions.includes("draft.read") ||
    workspace.permissions.includes("catalog.manage");
  const canUseStaffTools =
    workspace.permissions.includes("import.source.read") ||
    canReadCalendar ||
    canReadEditor;
  const upcomingItems = [
    { title: t.export, icon: "download", permission: "publication.export" },
  ] as const;
  const availableUpcoming = upcomingItems.filter((item) =>
    workspace.permissions.includes(item.permission),
  );
  return (
    <div className="workspace-layout workbench-layout portal-layout">
      <dialog
        ref={navigationDialog}
        id="portal-tools"
        className="portal-drawer"
        onKeyDown={(event) => {
          if (event.key === "Escape") event.stopPropagation();
        }}
        aria-labelledby="portal-menu-title"
        onClose={() => setMenuOpen(false)}
      >
        <aside className="sidebar">
          <div className="portal-drawer-heading">
            <h2 id="portal-menu-title">{portal.sections}</h2>
            <button
              className="button button-quiet"
              onClick={() => navigationDialog.current?.close()}
              aria-label={portal.closeMenu}
            >
              <Icon name="close" size={22} />
            </button>
          </div>
          <div className="sidebar-divider" />
          <nav aria-label={t.navTitle}>
            <p className="nav-heading">{t.navTitle}</p>
            <a
              href="#main"
              className={view === "overview" ? "nav-current" : "import-nav"}
              aria-current={view === "overview" ? "page" : undefined}
              onClick={(event) => {
                event.preventDefault();
                setView("overview");
              }}
            >
              <Icon name="grid" size={20} />
              {t.overview}
              {view === "overview" && <span className="nav-dot" />}
            </a>
            {workspace.permissions.includes("import.source.read") && (
              <button
                className="import-nav"
                aria-label={t.import}
                aria-current={view === "import" ? "page" : undefined}
                onClick={() => setView("import")}
              >
                <Icon name="file" size={20} />
                {wb.nav.import}
              </button>
            )}
            {canReadCalendar && (
              <button
                className="import-nav"
                aria-label={t.calendar}
                aria-current={view === "calendar" ? "page" : undefined}
                onClick={() => setView("calendar")}
              >
                <Icon name="clock" size={20} />
                {wb.nav.calendar}
              </button>
            )}
            {canReadEditor && (
              <button
                className="import-nav"
                aria-label={
                  workspace.permissions.includes("draft.read")
                    ? t.editor
                    : t.rooms
                }
                aria-current={view === "editor" ? "page" : undefined}
                onClick={() => setView("editor")}
              >
                <Icon name="calendar" size={20} />
                {workspace.permissions.includes("draft.read")
                  ? wb.nav.editor
                  : t.rooms}
              </button>
            )}
            {canReadEditor && (
              <button
                className="import-nav"
                aria-label={
                  workspace.permissions.includes("catalog.manage")
                    ? pm.conditions
                    : pm.title
                }
                aria-current={view === "planning" ? "page" : undefined}
                onClick={() => setView("planning")}
              >
                <Icon name="spark" size={20} />
                {workspace.permissions.includes("catalog.manage")
                  ? pm.conditions
                  : wb.nav.planning}
              </button>
            )}
            {workspace.permissions.includes("draft.read") && (
              <button
                className="import-nav"
                aria-label={t.publication}
                aria-current={view === "versions" ? "page" : undefined}
                onClick={() => setView("versions")}
              >
                <Icon name="layers" size={20} />
                {wb.nav.versions}
              </button>
            )}
            {workspace.permissions.some((p) =>
              p.startsWith("publication.read"),
            ) && (
              <button
                className="import-nav"
                aria-label={vm.publication}
                aria-current={view === "publications" ? "page" : undefined}
                onClick={() => setView("publications")}
              >
                <Icon name="calendar" size={20} />
                {wb.nav.publications}
              </button>
            )}
            {availableUpcoming.length > 0 && (
              <>
                <p className="nav-heading next-nav-heading">{t.nextTitle}</p>
                <div className="upcoming-nav">
                  {availableUpcoming.map((item) => (
                    <button
                      key={item.title}
                      type="button"
                      disabled
                      title={t.upcoming}
                    >
                      <Icon name={item.icon} size={19} />
                      <span>
                        {item.title}
                        <small>{t.upcoming}</small>
                      </span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </nav>
        </aside>
      </dialog>
      <div className="workspace-body">
        <header className="workspace-header portal-header">
          <Brand compact />
          <nav className="portal-primary-nav" aria-label={portal.navigation}>
            <a
              href="#main"
              aria-current={view === "overview" ? "page" : undefined}
              onClick={(event) => {
                event.preventDefault();
                setView("overview");
              }}
            >
              {portal.home}
            </a>
            {workspace.permissions.some((permission) =>
              permission.startsWith("publication.read"),
            ) && (
              <>
                <button
                  aria-current={view === "subjects" ? "page" : undefined}
                  onClick={() => {
                    setSubjectFocus("");
                    setSubjectVisit((value) => value + 1);
                    setView("subjects");
                  }}
                >
                  {subjectsLabel(workspace)}
                </button>
                <button
                  aria-current={view === "publications" ? "page" : undefined}
                  onClick={() => setView("publications")}
                >
                  {portal.schedule}
                </button>
              </>
            )}
          </nav>
          <div
            className={`portal-account ${canUseStaffTools ? "portal-account--staff" : ""}`}
          >
            {canUseStaffTools && (
              <button
                className="portal-menu-toggle"
                aria-label={portal.sections}
                aria-haspopup="dialog"
                aria-expanded={menuOpen}
                aria-controls="portal-tools"
                onClick={() => {
                  navigationDialog.current?.showModal();
                  setMenuOpen(true);
                }}
              >
                <Icon name="list" size={19} />
                <span>{portal.sections}</span>
              </button>
            )}
            <span className="portal-avatar" aria-hidden="true">
              {user.display_name.trim().slice(0, 1)}
            </span>
            <div className="portal-account-name">
              <strong>{user.display_name}</strong>
              <span>
                {activeRoles
                  .map((role) => roleNames[role] ?? t.unknownRole)
                  .join(", ")}
              </span>
            </div>
            <span className="language-label" aria-label={t.language}>
              ҚҚ
            </span>
            <button
              className="button button-quiet workbench-logout"
              onClick={() => {
                if (
                  (view === "planning" || view === "versions") &&
                  planningDirty &&
                  !window.confirm(pm.leaveDirty)
                )
                  return;
                void onLogout();
              }}
              disabled={busy}
            >
              <Icon name="logout" size={18} />
              <span>{busy ? t.signingOut : t.signOut}</span>
            </button>
          </div>
        </header>
        <div className="portal-context">
          <Icon name="grid" size={15} />
          <span>{workspace.scope.name}</span>
        </div>
        <main id="main" className="workspace-main" tabIndex={-1}>
          {error && (
            <p role="alert" className="error-message workspace-error">
              {error}
            </p>
          )}
          {view === "subjects" ? (
            <SubjectsPage
              key={subjectVisit}
              workspace={workspace}
              onExpired={onExpired}
              initialSubjectKey={subjectFocus}
              onOpenPublication={(id, date, group) => {
                setPublicationGroup(group);
                setPublicationFocus(id);
                setPublicationDate(date);
                setView("publications");
              }}
            />
          ) : view === "versions" ? (
            <VersionsPage
              initialVersionId={versionFocus}
              onSelectedVersion={setVersionFocus}
              scope={workspace.scope.id}
              userId={user.id}
              csrfToken={csrfToken}
              canSubmit={workspace.permissions.includes("draft.submit")}
              canApprove={workspace.permissions.includes("draft.approve")}
              canReject={workspace.permissions.includes("draft.reject")}
              canPublish={workspace.permissions.includes("draft.publish")}
              canEdit={workspace.permissions.includes("draft.edit")}
              onExpired={onExpired}
              onDirtyChange={setPlanningDirty}
              onOpenDraft={(id) => {
                setEditorDraftId(id);
                setView("editor");
              }}
            />
          ) : view === "publications" ? (
            <PublicationsPage
              initialMode="week"
              initialPublicationId={publicationFocus}
              initialDate={publicationDate}
              initialResourceId={publicationGroup}
              scope={workspace.scope.id}
              onExpired={onExpired}
            />
          ) : view === "planning" ? (
            <PlanningPage
              onDirtyChange={setPlanningDirty}
              scope={workspace.scope.id}
              csrfToken={csrfToken}
              canRun={workspace.permissions.includes("generator.run")}
              canRead={workspace.permissions.includes("draft.read")}
              canManage={workspace.permissions.includes("catalog.manage")}
              onExpired={onExpired}
              onOpenDraft={(id) => {
                setEditorDraftId(id);
                setView("editor");
              }}
            />
          ) : view === "editor" ? (
            <EditorPage
              initialMode="week"
              onOpenVersion={(id) => {
                setVersionFocus(id);
                setView("versions");
              }}
              initialDraftId={editorDraftId}
              scope={workspace.scope.id}
              csrfToken={csrfToken}
              canRead={workspace.permissions.includes("draft.read")}
              canEdit={workspace.permissions.includes("draft.edit")}
              canManageRooms={workspace.permissions.includes("catalog.manage")}
              onExpired={onExpired}
            />
          ) : view === "calendar" ? (
            <CalendarPage
              scope={workspace.scope.id}
              csrfToken={csrfToken}
              canWrite={workspace.permissions.includes("calendar.manage")}
              onExpired={onExpired}
            />
          ) : view === "import" ? (
            <ImportPage
              scope={workspace.scope.id}
              csrfToken={csrfToken}
              canWrite={workspace.permissions.includes("import.write")}
              onExpired={onExpired}
            />
          ) : (
            <>
              <WorkbenchHome
                workspace={workspace}
                onOpenSubject={(key) => {
                  setSubjectFocus(key);
                  setSubjectVisit((value) => value + 1);
                  setView("subjects");
                }}
                onNavigate={setView}
                onExpired={onExpired}
                onOpenDraft={(id) => {
                  setEditorDraftId(id);
                  setView("editor");
                }}
                onOpenPublication={(id, date, group) => {
                  setPublicationGroup(group);
                  setPublicationFocus(id);
                  setPublicationDate(date);
                  setView("publications");
                }}
              />
              <details className="account-disclosure">
                <summary>{wb.account}</summary>
                <p>
                  {user.email} · {t.secureSession}
                </p>
                <div className="workspace-columns">
                  <section
                    className="panel permissions-panel"
                    aria-labelledby="permissions-title"
                  >
                    <div className="panel-heading">
                      <span className="panel-icon">
                        <Icon name="lock" size={21} />
                      </span>
                      <div>
                        <h2 id="permissions-title">{t.accessTitle}</h2>
                        <p>{t.accessDescription}</p>
                      </div>
                    </div>
                    {workspace.permissions.length > 0 ? (
                      <ul className="permission-list">
                        {workspace.permissions.map((permission) => (
                          <li key={permission}>
                            <span className="permission-check">
                              <Icon name="check" size={15} />
                            </span>
                            <span>
                              {permissionNames[permission] ??
                                t.unknownPermission}
                            </span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="empty-message">{t.noPermissions}</p>
                    )}
                    <div className="panel-footnote">
                      <Icon name="lock" size={14} />
                      {t.secureSession}
                    </div>
                  </section>
                  <div className="right-column">
                    <section className="panel stage-panel">
                      <span className="mini-kicker">{t.stageLabel}</span>
                      <h2>{t.currentStageTitle}</h2>
                      <ul className="stage-list">
                        {t.currentStageItems.map((item) => (
                          <li key={item}>
                            <Icon name="check" size={17} />
                            <span>{item}</span>
                          </li>
                        ))}
                      </ul>
                    </section>
                    <section className="next-step">
                      <span className="next-step-icon">
                        <Icon name={isReader ? "calendar" : "file"} size={22} />
                      </span>
                      <div>
                        <h2>
                          {isReader ? t.noPublishedTitle : t.nextStepTitle}
                        </h2>
                        <p>{nextDescription}</p>
                        {isReader ? (
                          <button
                            className="button button-quiet"
                            onClick={() => setView("publications")}
                          >
                            {vm.publication}
                          </button>
                        ) : (
                          <span className="upcoming-label">
                            <Icon name="clock" size={14} />
                            {t.export} · {t.upcoming}
                          </span>
                        )}
                      </div>
                    </section>
                  </div>
                </div>
              </details>
            </>
          )}
        </main>
      </div>
    </div>
  );
}

export function App() {
  const [screen, setScreen] = useState<Screen>("loading");
  const [session, setSession] = useState<Session>({
    user: null,
    csrf_token: "",
  });
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const receiveSession = useCallback(async (result: Session) => {
    setSession(result);
    if (!result.user) {
      setWorkspace(null);
      setScreen("login");
      return;
    }
    try {
      const loaded = await api.workspace(result.user.home_scope_id);
      setWorkspace(loaded);
      setError("");
      setNotice("");
      setScreen("workspace");
    } catch (problem) {
      setWorkspace(null);
      if (problem instanceof ApiError && problem.status === 401) {
        const refreshed = await api.session();
        setSession({ user: null, csrf_token: refreshed.csrf_token });
        setNotice(t.sessionExpired);
        setScreen("login");
      } else {
        setError(errorMessage(problem));
        setScreen("error");
      }
    }
  }, []);

  const bootstrap = useCallback(async () => {
    setScreen("loading");
    setError("");
    try {
      await receiveSession(await api.session());
    } catch (problem) {
      setError(errorMessage(problem));
      setScreen("error");
    }
  }, [receiveSession]);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  // Re-check the server session after returning to a tab; no local role is authoritative.
  useEffect(() => {
    function check() {
      if (document.visibilityState === "visible" && screen === "workspace")
        void api
          .session()
          .then(receiveSession)
          .catch((problem) => setError(errorMessage(problem)));
    }
    document.addEventListener("visibilitychange", check);
    return () => document.removeEventListener("visibilitychange", check);
  }, [screen, receiveSession]);

  async function logout() {
    setBusy(true);
    setError("");
    try {
      try {
        await api.logout(session.csrf_token);
      } catch (problem) {
        if (!(problem instanceof ApiError) || problem.code !== "CSRF_INVALID")
          throw problem;
        const refreshed = await api.session();
        setSession(refreshed);
        if (refreshed.user) await api.logout(refreshed.csrf_token);
      }
      setSession({ user: null, csrf_token: "" });
      setWorkspace(null);
      await bootstrap();
    } catch (problem) {
      if (problem instanceof ApiError && problem.status === 401)
        await bootstrap();
      else setError(errorMessage(problem));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <a className="skip-link" href="#main">
        {t.skipLink}
      </a>
      {screen === "loading" && (
        <main id="main" className="state-screen">
          <Brand />
          <div className="loading-box" role="status">
            <span className="spinner" />
            {t.loading}
          </div>
        </main>
      )}
      {screen === "error" && (
        <main id="main" className="state-screen">
          <Brand />
          <div className="error-box">
            <Icon name="alert" size={28} />
            <p role="alert">{error}</p>
            <button
              className="button button-primary"
              onClick={() => void bootstrap()}
            >
              {t.retry}
            </button>
          </div>
        </main>
      )}
      {screen === "login" && (
        <Login
          session={session}
          notice={notice}
          onSuccess={receiveSession}
          onRefresh={async () => {
            const refreshed = await api.session();
            setSession({ user: null, csrf_token: refreshed.csrf_token });
          }}
        />
      )}
      {screen === "workspace" && session.user && workspace && (
        <WorkspaceScreen
          key={JSON.stringify([
            session.user.id,
            workspace.scope.id,
            session.user.grants
              .filter((grant) => grant.scope_id === workspace.scope.id)
              .map((grant) =>
                JSON.stringify([grant.role, grant.group_id, grant.teacher_id]),
              )
              .sort(),
          ])}
          user={session.user}
          workspace={workspace}
          onLogout={logout}
          busy={busy}
          error={error}
          csrfToken={session.csrf_token}
          onExpired={() => void bootstrap()}
        />
      )}
    </>
  );
}
