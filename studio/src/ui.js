const make = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const putText = (node, text) => {
  const next = text == null ? '' : String(text);
  if (node.textContent !== next) node.textContent = next;
};
const action = (text, className, handler) => {
  const node = make('button', `studio-button ${className || ''}`, text);
  node.type = 'button';
  if (handler) node.addEventListener('click', handler);
  return node;
};
const icon = (name, className = '') => {
  const paths = {
    arrow: 'M19 12H5m7-7-7 7 7 7',
    plus: 'M12 5v14M5 12h14',
    upload: 'M12 16V4m-5 5 5-5 5 5M4 16v4h16v-4',
    play: 'm9 5 11 7-11 7z',
    close: 'm6 6 12 12M6 18 18 6',
    check: 'm5 12 4 4L19 6',
    lock: 'M7 10V7a5 5 0 0 1 10 0v3M5 10h14v11H5z',
    document: 'M14 3H5v18h14V8zm0 0v5h5M8 12h8M8 16h6',
    people: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m20 0v-2a4 4 0 0 0-3-3.87M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8m8-7.87a4 4 0 0 1 0 7.75',
    copy: 'M9 9h12v12H9zM15 9V3H3v12h6',
    edit: 'm16 3 5 5-12 12H4v-5zm-2 2 5 5',
    warning: 'm12 3 10 18H2zm0 6v5m0 3v1'
  };
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.7');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', `studio-icon ${className}`);
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', paths[name] || paths.document);
  svg.append(path);
  return svg;
};
const iconButton = (text, className, iconName, handler) => {
  const node = action('', className, handler);
  node.append(icon(iconName), make('span', '', text));
  return node;
};
const field = (label, input, hint) => {
  const group = make('div', 'studio-field');
  const caption = make('label', 'studio-label', label);
  caption.htmlFor = input.id;
  group.append(caption, input);
  if (hint) {
    const help = make('p', 'studio-field-hint', hint);
    help.id = `${input.id}-hint`;
    input.setAttribute('aria-describedby', help.id);
    group.append(help);
  }
  return group;
};
const dateLabel = value => {
  const date = new Date(value || '');
  return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(date);
};
const isOwner = role => role === 'admin' || role === 'owner';
const presentationFormat = presentation => String(presentation.format || 'html').toLowerCase();

export class StudioUI {
  constructor(callbacks = {}, options = {}) {
    this.callbacks = callbacks;
    this.state = { view: 'loading', presentations: [], members: [], workspace: {} };
    this.localBusy = false;
    this.prefix = `studio-${Math.random().toString(36).slice(2, 8)}`;
    this.root = make('div', 'studio-root');
    this.element = this.root;
    this.root.dataset.studioUi = 'true';
    this.screens = {};
    this.buildHeader();
    this.notice = make('div', 'studio-notice');
    this.notice.setAttribute('role', 'status');
    this.notice.setAttribute('aria-live', 'polite');
    this.notice.hidden = true;
    this.root.append(this.notice);
    this.main = make('main', 'studio-main');
    this.root.append(this.main);
    this.buildSetup();
    this.buildAuth();
    this.buildLoading();
    this.buildLibrary();
    this.buildAccess();
    this.buildError();
    this.buildWorkspace();
    this.buildModal();
    this.escapeHandler = event => {
      if (event.key === 'Escape' && !this.modalOverlay.hidden) {
        event.preventDefault();
        event.stopPropagation();
        if (!this.localBusy) this.closeModal();
      }
    };
    document.addEventListener('keydown', this.escapeHandler, true);
    (options.mount || document.body).append(this.root);
    this.render({});
  }

  invoke(name, ...args) {
    return typeof this.callbacks[name] === 'function' ? this.callbacks[name](...args) : undefined;
  }

  async perform(name, payload, { close = false, after } = {}) {
    if (this.localBusy) return;
    if (typeof this.callbacks[name] !== 'function') {
      this.setFeedback('This action is not connected yet. Please contact the presentation owner.', true);
      return;
    }
    this.localBusy = true;
    this.setFeedback('');
    this.updateBusy();
    try {
      const result = await this.invoke(name, payload);
      if (result === false) return result;
      if (close) this.closeModal(true);
      if (after) after(result);
      return result;
    } catch (error) {
      this.setFeedback(error?.message || 'Something went wrong. Please try again.', true);
    } finally {
      this.localBusy = false;
      this.updateBusy();
    }
  }

  screen(name, className = '') {
    const screen = make('section', `studio-screen ${className}`);
    screen.hidden = true;
    this.screens[name] = screen;
    this.main.append(screen);
    return screen;
  }

  buildHeader() {
    this.header = make('header', 'studio-header');
    this.brand = action('', 'studio-brand', () => this.invoke('onNavigate', 'library'));
    const mark = make('span', 'studio-brand-mark');
    mark.setAttribute('aria-hidden', 'true');
    mark.append(make('span'), make('span'), make('span'));
    this.brand.append(mark, make('span', '', 'Presentation Studio'));
    this.nav = make('nav', 'studio-nav');
    this.nav.setAttribute('aria-label', 'Studio');
    this.libraryNav = action('Presentations', 'studio-nav-link', () => this.invoke('onNavigate', 'library'));
    this.accessNav = action('Team access', 'studio-nav-link', () => this.invoke('onNavigate', 'access'));
    this.nav.append(this.libraryNav, this.accessNav);
    this.account = make('div', 'studio-header-account');
    this.accountEmail = make('span', 'studio-account-email');
    this.signOut = action('Sign out', 'studio-button-quiet', () => this.perform('onSignOut'));
    this.account.append(this.accountEmail, this.signOut);
    this.header.append(this.brand, this.nav, this.account);
    this.root.append(this.header);
  }

  buildSetup() {
    const screen = this.screen('configuring', 'studio-centered');
    const card = make('div', 'studio-state-card');
    card.append(icon('lock', 'studio-state-icon'), make('p', 'studio-eyebrow', 'WORKSPACE SETUP'));
    card.append(make('h1', 'studio-state-title', 'Your studio is almost ready.'));
    card.append(make('p', 'studio-state-copy', 'Shared presentations and secure editor access need to be connected before this workspace can open.'));
    this.setupDetail = make('p', 'studio-setup-detail', 'The presentation owner can finish the workspace connection and then reload this page.');
    card.append(this.setupDetail);
    card.append(action('Check connection', 'studio-button-primary', () => this.perform('onRetry')));
    screen.append(card);
  }

  buildAuth() {
    const screen = this.screen('signin', 'studio-auth-screen');
    const introduction = make('div', 'studio-auth-intro');
    introduction.append(make('p', 'studio-eyebrow', 'A PLACE FOR YOUR PRESENTATIONS'));
    introduction.append(make('h1', 'studio-auth-title', 'Make your next\npresentation yours.'));
    introduction.append(make('p', 'studio-auth-copy', 'Refine the words, images, and motion. Keep every update together in one shared workspace.'));
    const artwork = make('div', 'studio-auth-art');
    artwork.setAttribute('aria-hidden', 'true');
    artwork.append(make('div', 'studio-art-sheet studio-art-back'), make('div', 'studio-art-sheet studio-art-front'));
    const artCaption = make('span', 'studio-art-caption', 'CREATE. REFINE. PRESENT.');
    artwork.append(artCaption);
    introduction.append(artwork);
    this.authCard = make('div', 'studio-auth-card');
    this.authEyebrow = make('p', 'studio-eyebrow', 'WELCOME BACK');
    this.authTitle = make('h2', 'studio-auth-form-title', 'Sign in to your studio');
    this.authDescription = make('p', 'studio-muted', 'Use the email invited to this workspace.');
    this.authForm = make('form', 'studio-auth-form');
    this.authForm.setAttribute('aria-label', 'Studio sign in');
    this.email = make('input', 'studio-input');
    Object.assign(this.email, { id: `${this.prefix}-email`, name: 'email', type: 'email', autocomplete: 'username', required: true, spellcheck: false });
    this.email.autocapitalize = 'none';
    this.emailField = field('Email address', this.email);
    this.password = make('input', 'studio-input');
    Object.assign(this.password, { id: `${this.prefix}-password`, name: 'password', type: 'password', autocomplete: 'current-password', required: true });
    this.passwordField = field('Password', this.password);
    this.passwordConfirm = make('input', 'studio-input');
    Object.assign(this.passwordConfirm, { id: `${this.prefix}-confirm-password`, name: 'confirm-password', type: 'password', autocomplete: 'new-password', required: true });
    this.passwordConfirmField = field('Confirm password', this.passwordConfirm);
    this.password.addEventListener('input', () => this.passwordConfirm.setCustomValidity(''));
    this.passwordConfirm.addEventListener('input', () => this.passwordConfirm.setCustomValidity(''));
    this.authSubmit = action('Sign in', 'studio-button-primary studio-full');
    this.authSubmit.type = 'submit';
    this.authForm.append(this.emailField, this.passwordField, this.passwordConfirmField, this.authSubmit);
    this.authForm.addEventListener('submit', event => {
      event.preventDefault();
      this.submitAuth();
    });
    this.forgotButton = action('Forgot password?', 'studio-text-button', () => this.changeAuthMode('recovery'));
    this.backToSignIn = action('Back to sign in', 'studio-text-button', () => this.changeAuthMode('signin'));
    this.authFooter = make('p', 'studio-auth-footnote', 'Access is by invitation from your presentation owner.');
    this.authCard.append(this.authEyebrow, this.authTitle, this.authDescription, this.authForm, this.forgotButton, this.backToSignIn, this.authFooter);
    screen.append(introduction, this.authCard);
  }

  changeAuthMode(mode) {
    this.password.value = '';
    this.passwordConfirm.value = '';
    this.render({ authMode: mode, error: '', notice: '' });
    if (typeof this.callbacks.onAuthMode === 'function') this.invoke('onAuthMode', mode);
    (mode === 'set-password' ? this.password : this.email).focus();
  }

  submitAuth() {
    const mode = this.state.authMode || 'signin';
    if (mode === 'recovery') {
      if (this.email.reportValidity()) this.perform('onRequestRecovery', this.email.value.trim());
    } else if (mode === 'set-password') {
      this.passwordConfirm.setCustomValidity(this.password.value === this.passwordConfirm.value ? '' : 'Passwords must match.');
      if (this.password.reportValidity() && this.passwordConfirm.reportValidity()) {
        this.perform('onSetPassword', this.password.value, { after: () => { this.password.value = ''; this.passwordConfirm.value = ''; } });
      }
    } else if (this.email.reportValidity() && this.password.reportValidity()) {
      this.perform('onSignIn', { email: this.email.value.trim(), password: this.password.value }, { after: () => { this.password.value = ''; } });
    }
  }

  buildLoading() {
    const screen = this.screen('loading', 'studio-centered');
    screen.setAttribute('aria-busy', 'true');
    const content = make('div', 'studio-loading');
    content.append(make('div', 'studio-spinner'));
    this.loadingLabel = make('p', 'studio-muted', 'Opening your workspace…');
    content.append(this.loadingLabel);
    screen.append(content);
  }

  buildLibrary() {
    const screen = this.screen('library', 'studio-library');
    const top = make('div', 'studio-page-heading');
    const text = make('div');
    text.append(make('p', 'studio-eyebrow', 'YOUR WORKSPACE'), make('h1', 'studio-page-title', 'Presentations'));
    this.librarySubtitle = make('p', 'studio-page-description', 'A shared home for your ideas, ready to refine and present.');
    text.append(this.librarySubtitle);
    this.uploadButton = iconButton('Upload presentation', 'studio-button-primary', 'plus', () => this.showUpload());
    top.append(text, this.uploadButton);
    this.libraryMeta = make('div', 'studio-library-meta');
    this.libraryCount = make('p', 'studio-collection-count');
    this.libraryMeta.append(this.libraryCount, make('span', 'studio-library-note', 'HTML · PowerPoint · PDF'));
    this.cardGrid = make('div', 'studio-card-grid');
    this.emptyLibrary = make('div', 'studio-empty-library');
    this.emptyLibrary.append(icon('document', 'studio-empty-icon'), make('h2', 'studio-empty-title', 'Room for your next presentation.'));
    this.emptyLibraryCopy = make('p', 'studio-muted');
    this.emptyUploadButton = iconButton('Upload your first presentation', 'studio-button-primary', 'upload', () => this.showUpload());
    this.emptyLibrary.append(this.emptyLibraryCopy, this.emptyUploadButton);
    screen.append(top, this.libraryMeta, this.cardGrid, this.emptyLibrary);
  }

  presentationCard(presentation, index) {
    const format = presentationFormat(presentation);
    const editable = format === 'html' && presentation.canEdit !== false && this.state.role !== 'viewer';
    const card = make('article', 'studio-presentation-card');
    const cover = action('', 'studio-card-cover', () => this.invoke(editable ? 'onOpen' : 'onPresent', presentation.id));
    cover.setAttribute('aria-label', `Open ${presentation.title || 'Untitled presentation'}`);
    const fallback = make('div', `studio-cover-art studio-cover-variant-${index % 3}`);
    fallback.setAttribute('aria-hidden', 'true');
    fallback.append(make('span', 'studio-cover-small', 'PRESENTATION'), make('span', 'studio-cover-name', presentation.title || 'Untitled presentation'), make('span', 'studio-cover-shape'), make('span', 'studio-cover-rule'));
    cover.append(fallback);
    const coverUrl = presentation.coverUrl || presentation.cover_url;
    if (typeof coverUrl === 'string' && /^(https?:|blob:|data:image\/(png|jpeg|webp|gif);)/i.test(coverUrl)) {
      const image = make('img', 'studio-cover-image');
      image.src = coverUrl;
      image.alt = '';
      image.loading = 'lazy';
      image.addEventListener('error', () => image.remove(), { once: true });
      cover.append(image);
    }
    const content = make('div', 'studio-card-content');
    const title = make('h2', 'studio-card-title', presentation.title || 'Untitled presentation');
    const date = presentation.updatedLabel || dateLabel(presentation.updated_at || presentation.updatedAt);
    const meta = make('div', 'studio-card-meta');
    meta.append(make('span', 'studio-format-badge', format === 'pptx' ? 'PowerPoint' : format.toUpperCase()), make('span', '', date ? `Updated ${date}` : 'Ready to open'));
    if (presentation.slide_count) meta.append(make('span', '', `${presentation.slide_count} slides`));
    const actions = make('div', 'studio-card-actions');
    const edit = iconButton('Open editor', 'studio-button-secondary', 'edit', () => this.invoke('onOpen', presentation.id));
    const present = iconButton('Present', 'studio-button-quiet', 'play', () => this.invoke('onPresent', presentation.id));
    edit.hidden = !editable;
    actions.append(edit, present);
    if (format !== 'html') {
      const download = iconButton('Download original', 'studio-button-secondary', 'document', () => this.invoke('onDownloadOriginal', presentation.id));
      download.setAttribute('aria-label', `Download original ${presentation.title || 'presentation'}`);
      actions.append(download);
    }
    content.append(title, meta, actions);
    card.append(cover, content);
    return card;
  }

  showUpload() {
    if (!isOwner(this.state.role)) return;
    const form = make('form', 'studio-modal-form');
    const title = make('input', 'studio-input');
    Object.assign(title, { id: `${this.prefix}-upload-title`, name: 'title', type: 'text', required: true, maxLength: 160, placeholder: 'Give this presentation a name' });
    const file = make('input', 'studio-file-input');
    Object.assign(file, { id: `${this.prefix}-upload-file`, name: 'file', type: 'file', accept: '.html,.htm,.pptx,.pdf,text/html,application/pdf,application/vnd.openxmlformats-officedocument.presentationml.presentation', required: true });
    file.addEventListener('change', () => {
      if (!title.value && file.files?.[0]) title.value = file.files[0].name.replace(/\.(html?|pptx|pdf)$/i, '').replace(/[-_]/g, ' ');
      file.setCustomValidity(file.files?.[0]?.size > 40 * 1024 * 1024 ? 'Choose a file smaller than 40 MB.' : '');
    });
    form.append(field('Presentation title', title), field('Presentation file', file, 'HTML, PowerPoint (.pptx), or PDF. Maximum 40 MB.'));
    form.append(make('p', 'studio-upload-helper', 'HTML keeps its animations and supports editing. PowerPoint and PDF can be uploaded and presented; browser previews may differ from the original.'));
    const footer = make('div', 'studio-modal-actions');
    const cancel = action('Cancel', 'studio-button-secondary', () => this.closeModal());
    const submit = iconButton('Upload presentation', 'studio-button-primary', 'upload');
    submit.type = 'submit';
    footer.append(cancel, submit);
    form.append(footer);
    form.addEventListener('submit', event => {
      event.preventDefault();
      if (title.reportValidity() && file.reportValidity() && file.files?.[0]) {
        this.perform('onUpload', { title: title.value.trim(), file: file.files[0] }, { close: true });
      }
    });
    this.openModal('Add a presentation', 'Bring a presentation into your shared workspace.', form);
    title.focus();
  }

  buildAccess() {
    const screen = this.screen('access', 'studio-access');
    this.ownerAccess = make('div');
    const heading = make('div', 'studio-page-heading');
    const headingText = make('div');
    headingText.append(make('p', 'studio-eyebrow', 'WORKSPACE SETTINGS'), make('h1', 'studio-page-title', 'Team access'), make('p', 'studio-page-description', 'Give your clients a place to edit, and keep access in your hands.'));
    heading.append(headingText);
    this.memberForm = make('form', 'studio-member-form');
    this.memberEmail = make('input', 'studio-input');
    Object.assign(this.memberEmail, { id: `${this.prefix}-member-email`, type: 'email', autocomplete: 'email', name: 'member-email', required: true, placeholder: 'editor@example.com' });
    this.memberEmail.autocapitalize = 'none';
    this.memberRole = make('select', 'studio-input');
    this.memberRole.id = `${this.prefix}-member-role`;
    [['editor', 'Editor — edit & present'], ['admin', 'Owner — manage studio']].forEach(([value, label]) => {
      const option = make('option', '', label);
      option.value = value;
      this.memberRole.append(option);
    });
    this.addMember = iconButton('Add member', 'studio-button-primary', 'plus');
    this.addMember.type = 'submit';
    this.memberForm.append(field('Email address', this.memberEmail), field('Role', this.memberRole), this.addMember);
    this.memberForm.addEventListener('submit', event => {
      event.preventDefault();
      if (!this.memberEmail.reportValidity()) return;
      this.perform('onAddMember', { email: this.memberEmail.value.trim(), role: this.memberRole.value }, { after: result => {
        this.memberEmail.value = '';
        const url = typeof result === 'string' ? result : result?.url || result?.inviteUrl;
        if (url) this.showInvite(url);
      } });
    });
    this.memberSummary = make('p', 'studio-member-summary');
    this.memberList = make('div', 'studio-member-list');
    this.memberList.setAttribute('aria-label', 'Workspace members');
    this.ownerAccess.append(heading, this.memberForm, this.memberSummary, this.memberList);
    this.pendingAccess = make('div', 'studio-centered studio-access-pending');
    const card = make('div', 'studio-state-card');
    card.append(icon('lock', 'studio-state-icon'), make('p', 'studio-eyebrow', 'ACCESS NEEDED'), make('h1', 'studio-state-title', 'You’re signed in.\nYour workspace is next.'));
    this.pendingAccessText = make('p', 'studio-state-copy', 'Ask the presentation owner to add your email to this workspace, then check access again.');
    this.pendingEmail = make('p', 'studio-pending-email');
    card.append(this.pendingAccessText, this.pendingEmail, action('Check access', 'studio-button-primary', () => this.perform('onRetry')));
    this.pendingAccess.append(card);
    screen.append(this.ownerAccess, this.pendingAccess);
  }

  memberRow(member) {
    const row = make('div', 'studio-member-row');
    const identity = make('div', 'studio-member-identity');
    const avatar = make('span', 'studio-member-avatar', (member.email || '?').slice(0, 1).toUpperCase());
    avatar.setAttribute('aria-hidden', 'true');
    const text = make('div');
    text.append(make('p', 'studio-member-email', member.email || 'Member'), make('p', 'studio-member-status', member.status || 'Workspace member'));
    identity.append(avatar, text);
    const role = make('span', 'studio-role-badge', isOwner(member.role) ? 'Owner' : member.role === 'viewer' ? 'Viewer' : 'Editor');
    const buttons = make('div', 'studio-member-actions');
    const invite = action('Invitation link', 'studio-button-secondary', () => this.perform('onInvite', member, { after: result => {
      const url = typeof result === 'string' ? result : result?.url || result?.inviteUrl;
      if (url) this.showInvite(url, member.email);
    } }));
    const revoke = action('Remove', 'studio-button-danger-quiet', () => this.confirmRevoke(member));
    revoke.disabled = member.canRevoke === false;
    revoke.dataset.fixedDisabled = member.canRevoke === false ? 'true' : 'false';
    revoke.setAttribute('aria-label', `Remove access for ${member.email || 'member'}`);
    invite.setAttribute('aria-label', `Get invitation link for ${member.email || 'member'}`);
    buttons.append(invite, revoke);
    row.append(identity, role, buttons);
    return row;
  }

  confirmRevoke(member) {
    const content = make('div');
    content.append(make('p', 'studio-modal-warning', `${member.email || 'This member'} will lose access to presentations in this workspace.`));
    const controls = make('div', 'studio-modal-actions');
    controls.append(action('Keep access', 'studio-button-secondary', () => this.closeModal()), action('Remove access', 'studio-button-danger', () => this.perform('onRevokeMember', member, { close: true })));
    content.append(controls);
    this.openModal('Remove workspace access?', 'Existing presentation content will remain in the workspace.', content, 'alertdialog');
  }

  showInvite(url, email) {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return;
    const content = make('div');
    const input = make('input', 'studio-input studio-invite-input');
    Object.assign(input, { id: `${this.prefix}-invite-link`, type: 'text', value: url, readOnly: true });
    content.append(field('Invitation link', input, 'Send this private link only to the person you invited.'));
    const controls = make('div', 'studio-modal-actions');
    const copy = iconButton('Copy link', 'studio-button-primary', 'copy', async () => {
      try {
        if (typeof this.callbacks.onCopyInvite === 'function') await this.invoke('onCopyInvite', url);
        else await navigator.clipboard.writeText(url);
        copy.replaceChildren(icon('check'), make('span', '', 'Copied'));
      } catch {
        input.focus();
        input.select();
        this.setFeedback('Select and copy the invitation link above.', false);
      }
    });
    controls.append(action('Done', 'studio-button-secondary', () => this.closeModal()), copy);
    content.append(controls);
    this.openModal('Your invitation is ready', email ? `Share this invitation with ${email}.` : 'Your teammate can use this link to set up their editor access.', content);
  }

  buildError() {
    const screen = this.screen('error', 'studio-centered');
    const card = make('div', 'studio-state-card');
    card.append(icon('warning', 'studio-state-icon'), make('p', 'studio-eyebrow', 'LET’S TRY THAT AGAIN'));
    this.errorTitle = make('h1', 'studio-state-title', 'The studio couldn’t open.');
    this.errorDescription = make('p', 'studio-state-copy', 'Check your connection and try again.');
    card.append(this.errorTitle, this.errorDescription, action('Try again', 'studio-button-primary', () => this.perform('onRetry')));
    screen.append(card);
  }

  buildWorkspace() {
    this.workspace = make('section', 'studio-workspace');
    this.workspace.hidden = true;
    this.workspace.setAttribute('aria-label', 'Presentation workspace');
    this.workspaceToolbar = make('header', 'studio-workspace-toolbar');
    this.backButton = iconButton('Library', 'studio-button-quiet studio-workspace-back', 'arrow', () => this.invoke('onBack'));
    const identity = make('div', 'studio-workspace-identity');
    this.workspaceTitle = make('h1', 'studio-workspace-title', 'Presentation');
    this.workspaceSaveState = make('p', 'studio-workspace-save-state', 'Ready to edit');
    this.workspaceSaveState.setAttribute('role', 'status');
    this.workspaceSaveState.setAttribute('aria-live', 'polite');
    identity.append(this.workspaceTitle, this.workspaceSaveState);
    this.workspaceActions = make('div', 'studio-workspace-actions');
    this.saveButton = iconButton('Save to cloud', 'studio-button-primary', 'check', () => this.perform('onSave'));
    this.presentButton = iconButton('Present', 'studio-button-secondary', 'play', () => this.invoke('onTogglePresent', true));
    this.workspaceDownload = iconButton('Download original', 'studio-button-secondary', 'document', () => this.invoke('onDownloadOriginal', this.state.workspace.id));
    this.closePresent = iconButton('Close presentation', 'studio-button-secondary studio-close-present', 'close', () => this.invoke('onTogglePresent', false));
    this.workspaceActions.append(this.saveButton, this.presentButton, this.workspaceDownload, this.closePresent);
    this.workspaceToolbar.append(this.backButton, identity, this.workspaceActions);
    this.frameHost = make('div', 'studio-frame-host');
    this.frameHost.setAttribute('aria-label', 'Presentation');
    this.workspaceConflict = make('div', 'studio-workspace-conflict');
    this.workspaceConflict.hidden = true;
    this.workspaceConflict.setAttribute('role', 'alert');
    this.workspaceConflictText = make('p');
    this.retrySave = action('Retry save', 'studio-button-secondary', () => this.perform('onSave'));
    this.reloadPresentation = action('Load cloud version', 'studio-button-secondary', () => this.confirmReloadPresentation());
    const conflictActions = make('div', 'studio-conflict-actions');
    conflictActions.append(this.retrySave, this.reloadPresentation);
    this.workspaceConflict.append(this.workspaceConflictText, conflictActions);
    this.workspace.append(this.workspaceToolbar, this.workspaceConflict, this.frameHost);
    this.root.append(this.workspace);
  }

  confirmReloadPresentation() {
    const content = make('div');
    content.append(make('p', 'studio-modal-warning', 'Your unsaved changes in this session will be discarded and replaced with the latest version saved to the cloud.'));
    const controls = make('div', 'studio-modal-actions');
    controls.append(action('Keep my changes', 'studio-button-secondary', () => this.closeModal()), action('Load cloud version', 'studio-button-danger', () => this.perform('onReloadPresentation', this.state.workspace.id, { close: true })));
    content.append(controls);
    this.openModal('Replace your local changes?', 'Load the current shared version of this presentation.', content, 'alertdialog');
  }

  buildModal() {
    this.modalOverlay = make('div', 'studio-modal-overlay');
    this.modalOverlay.hidden = true;
    this.dialog = make('section', 'studio-modal');
    this.dialog.setAttribute('role', 'dialog');
    this.dialog.setAttribute('aria-modal', 'true');
    this.dialog.setAttribute('aria-labelledby', `${this.prefix}-modal-title`);
    this.dialog.setAttribute('aria-describedby', `${this.prefix}-modal-description`);
    this.modalClose = iconButton('Close', 'studio-modal-close', 'close', () => this.closeModal());
    this.modalTitle = make('h2', 'studio-modal-title');
    this.modalTitle.id = `${this.prefix}-modal-title`;
    this.modalDescription = make('p', 'studio-muted');
    this.modalDescription.id = `${this.prefix}-modal-description`;
    this.modalFeedback = make('p', 'studio-modal-feedback');
    this.modalFeedback.setAttribute('role', 'status');
    this.modalFeedback.hidden = true;
    this.modalContent = make('div', 'studio-modal-content');
    this.dialog.append(this.modalClose, this.modalTitle, this.modalDescription, this.modalFeedback, this.modalContent);
    this.modalOverlay.append(this.dialog);
    this.root.append(this.modalOverlay);
    this.modalOverlay.addEventListener('click', event => {
      if (event.target === this.modalOverlay && !this.localBusy) this.closeModal();
    });
    this.dialog.addEventListener('keydown', event => {
      if (event.key !== 'Tab') return;
      const focusable = [...this.dialog.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]')].filter(node => !node.hidden);
      if (!focusable.length) { event.preventDefault(); return; }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    });
  }

  openModal(title, description, content, role = 'dialog') {
    this.previousFocus = document.activeElement;
    putText(this.modalTitle, title);
    putText(this.modalDescription, description);
    this.dialog.setAttribute('role', role);
    this.modalContent.replaceChildren(content);
    this.modalFeedback.hidden = true;
    this.modalOverlay.hidden = false;
    this.header.inert = true;
    this.main.inert = true;
    this.workspace.inert = true;
    this.modalClose.focus();
  }

  closeModal(force = false) {
    if (this.localBusy && !force) return;
    this.modalOverlay.hidden = true;
    this.header.inert = false;
    this.main.inert = false;
    this.workspace.inert = false;
    if (this.previousFocus?.isConnected) this.previousFocus.focus({ preventScroll: true });
  }

  setFeedback(message, error = false) {
    const target = !this.modalOverlay.hidden ? this.modalFeedback : this.notice;
    putText(target, message);
    target.hidden = !message;
    target.classList.toggle('is-error', error);
  }

  updateBusy() {
    const busy = Boolean(this.state.busy || this.localBusy);
    this.root.classList.toggle('is-busy', busy);
    this.authForm.setAttribute('aria-busy', String(busy));
    this.authSubmit.disabled = busy;
    this.email.disabled = busy;
    this.password.disabled = busy;
    this.passwordConfirm.disabled = busy;
    this.signOut.disabled = busy;
    this.addMember.disabled = busy;
    this.uploadButton.disabled = busy;
    this.emptyUploadButton.disabled = busy;
    this.modalClose.disabled = busy;
    this.dialog.querySelectorAll('button, input, select').forEach(node => { node.disabled = busy; });
    this.memberList.querySelectorAll('button').forEach(node => { node.disabled = busy || node.dataset.fixedDisabled === 'true'; });
    const workspace = this.state.workspace || {};
    this.saveButton.disabled = busy || Boolean(workspace.isSaving) || workspace.canSave === false;
    this.saveButton.setAttribute('aria-busy', String(Boolean(workspace.isSaving)));
    this.saveButton.querySelector('span').textContent = workspace.isSaving ? 'Saving…' : 'Save to cloud';
    this.authSubmit.textContent = busy ? 'Please wait…' : this.state.authMode === 'recovery' ? 'Send recovery link' : this.state.authMode === 'set-password' ? 'Set password & continue' : 'Sign in';
  }

  render(partial = {}) {
    this.state = { ...this.state, ...partial, workspace: { ...this.state.workspace, ...(partial.workspace || {}) } };
    const state = this.state;
    const view = (this.screens[state.view] || state.view === 'workspace') ? state.view : 'error';
    const workspaceOpen = view === 'workspace';
    this.root.classList.toggle('has-workspace', workspaceOpen);
    this.header.hidden = workspaceOpen;
    this.main.hidden = workspaceOpen;
    Object.entries(this.screens).forEach(([name, screen]) => { screen.hidden = name !== view; });
    this.workspace.hidden = !workspaceOpen;
    this.nav.hidden = !state.user || !state.role || view === 'signin';
    this.account.hidden = !state.user;
    this.accessNav.hidden = !isOwner(state.role);
    this.libraryNav.setAttribute('aria-current', view === 'library' ? 'page' : 'false');
    this.accessNav.setAttribute('aria-current', view === 'access' ? 'page' : 'false');
    putText(this.accountEmail, state.user?.email || '');
    if (Object.hasOwn(partial, 'error') || Object.hasOwn(partial, 'notice')) this.setFeedback(state.error || state.notice || '', Boolean(state.error));
    putText(this.setupDetail, state.setupMessage || 'The presentation owner can finish the workspace connection and then reload this page.');
    putText(this.loadingLabel, state.loadingMessage || 'Opening your workspace…');
    putText(this.errorTitle, state.errorTitle || 'The studio couldn’t open.');
    putText(this.errorDescription, state.error || state.errorMessage || 'Check your connection and try again.');
    this.renderAuth();
    this.renderLibrary();
    this.renderAccess();
    this.renderWorkspace();
    this.updateBusy();
    if (state.inviteUrl && state.inviteUrl !== this.lastInviteUrl) {
      this.lastInviteUrl = state.inviteUrl;
      this.showInvite(state.inviteUrl, state.inviteEmail);
    }
  }

  renderAuth() {
    const mode = this.state.authMode || 'signin';
    const recovery = mode === 'recovery';
    const setPassword = mode === 'set-password';
    this.emailField.hidden = setPassword;
    this.email.required = !setPassword;
    this.passwordField.hidden = recovery;
    this.password.required = !recovery;
    this.passwordConfirmField.hidden = !setPassword;
    this.passwordConfirm.required = setPassword;
    this.password.autocomplete = setPassword ? 'new-password' : 'current-password';
    this.password.minLength = setPassword ? 8 : 1;
    this.forgotButton.hidden = recovery || setPassword || typeof this.callbacks.onRequestRecovery !== 'function';
    this.backToSignIn.hidden = !recovery;
    putText(this.authEyebrow, recovery ? 'BACK TO YOUR WORKSPACE' : setPassword ? 'YOUR INVITATION' : 'WELCOME BACK');
    putText(this.authTitle, recovery ? 'Reset your password' : setPassword ? 'Set up your studio account' : 'Sign in to your studio');
    putText(this.authDescription, recovery ? 'We’ll send a recovery link to your workspace email.' : setPassword ? 'Choose a password of at least 8 characters to continue.' : 'Use the email invited to this workspace.');
    this.authForm.setAttribute('aria-label', recovery ? 'Recover studio account' : setPassword ? 'Set account password' : 'Studio sign in');
    this.authFooter.hidden = setPassword;
    putText(this.authFooter, typeof this.callbacks.onRequestRecovery === 'function' ? 'Access is by invitation from your presentation owner.' : 'Need access or a new password? Ask the presentation owner for a fresh invitation.');
  }

  renderLibrary() {
    const owner = isOwner(this.state.role);
    const presentations = Array.isArray(this.state.presentations) ? this.state.presentations : [];
    this.uploadButton.hidden = !owner;
    this.emptyUploadButton.hidden = !owner;
    putText(this.libraryCount, `${presentations.length} presentation${presentations.length === 1 ? '' : 's'}`);
    this.emptyLibrary.hidden = presentations.length !== 0;
    this.libraryMeta.hidden = presentations.length === 0;
    this.cardGrid.hidden = presentations.length === 0;
    putText(this.emptyLibraryCopy, owner ? 'Upload HTML, PowerPoint, or PDF to bring your presentation into the shared workspace.' : 'Your presentation owner will add presentations to this workspace.');
    const signature = JSON.stringify([this.state.role, presentations]);
    if (signature !== this.librarySignature) {
      this.cardGrid.replaceChildren(...presentations.map((presentation, index) => this.presentationCard(presentation, index)));
      this.librarySignature = signature;
    }
  }

  renderAccess() {
    const owner = isOwner(this.state.role);
    this.ownerAccess.hidden = !owner;
    this.pendingAccess.hidden = owner;
    putText(this.pendingEmail, this.state.user?.email || '');
    putText(this.pendingAccessText, this.state.accessMessage || 'Ask the presentation owner to add your email to this workspace, then check access again.');
    const members = Array.isArray(this.state.members) ? this.state.members : [];
    putText(this.memberSummary, `${members.length} workspace member${members.length === 1 ? '' : 's'}`);
    const signature = JSON.stringify(members);
    if (signature !== this.membersSignature) {
      this.memberList.replaceChildren(...members.map(member => this.memberRow(member)));
      this.membersSignature = signature;
    }
  }

  renderWorkspace() {
    const workspace = this.state.workspace;
    putText(this.workspaceTitle, workspace.title || 'Presentation');
    const saveState = workspace.isSaving ? 'Saving to cloud…' : workspace.saveState || (workspace.dirty ? 'Changes to save' : 'Ready to edit');
    putText(this.workspaceSaveState, saveState);
    this.workspaceSaveState.classList.toggle('has-changes', Boolean(workspace.dirty));
    this.workspaceSaveState.classList.toggle('is-error', Boolean(workspace.saveError));
    this.workspace.classList.toggle('is-presenting', Boolean(workspace.presenting));
    const editable = workspace.editable !== false;
    this.closePresent.hidden = !workspace.presenting;
    this.presentButton.hidden = Boolean(workspace.presenting);
    this.saveButton.hidden = Boolean(workspace.presenting) || this.state.role === 'viewer' || !editable;
    this.workspaceDownload.hidden = Boolean(workspace.presenting) || editable;
    this.workspaceConflict.hidden = !workspace.conflictMessage && !workspace.saveError;
    putText(this.workspaceConflictText, workspace.conflictMessage || workspace.saveError || 'The cloud version changed. Review your draft before saving.');
    this.retrySave.hidden = !workspace.canRetrySave;
    this.reloadPresentation.hidden = typeof this.callbacks.onReloadPresentation !== 'function';
  }

  destroy() {
    document.removeEventListener('keydown', this.escapeHandler, true);
    this.root.remove();
  }
}
