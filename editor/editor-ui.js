(function () {
  'use strict';

  function element(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(text, className, action) {
    var node = element('button', className, text);
    node.type = 'button';
    if (action) node.addEventListener('click', action);
    return node;
  }

  function setText(node, value) {
    value = value === undefined || value === null ? '' : String(value);
    if (node.textContent !== value) node.textContent = value;
  }

  function field(label, control, hint) {
    var group = element('div', 'pe-field');
    var labelNode = element('label', 'pe-label', label);
    labelNode.htmlFor = control.id;
    group.append(labelNode, control);
    if (hint) {
      var help = element('p', 'pe-hint', hint);
      help.id = control.id + '-help';
      control.setAttribute('aria-describedby', help.id);
      group.append(help);
    }
    return group;
  }

  class PresentationEditorUI {
    constructor(callbacks) {
      this.callbacks = callbacks || {};
      this.open = false;
      this.selected = null;
      this.activeTab = 'text';
      this.pendingImage = null;
      this.lastSelectionSignature = '';
      this.idPrefix = 'pe-' + Math.random().toString(36).slice(2, 8);
      this.root = element('div', 'pe-root');
      this.element = this.root;
      this.root.dataset.presentationEditorUi = 'true';

      this.launcher = button('Edit presentation', 'pe-launcher', () => this.toggle(true));
      this.launcher.setAttribute('aria-expanded', 'false');
      this.launcher.setAttribute('aria-controls', this.idPrefix + '-panel');
      this.root.append(this.launcher);

      this.panel = element('aside', 'pe-panel');
      this.panel.id = this.idPrefix + '-panel';
      this.panel.setAttribute('aria-label', 'Presentation editor');
      this.panel.hidden = true;
      this.root.append(this.panel);

      var header = element('div', 'pe-header');
      var titleBlock = element('div');
      titleBlock.append(element('p', 'pe-eyebrow', 'PRESENTATION TOOLS'));
      var heading = element('h2', 'pe-heading', 'Edit presentation');
      titleBlock.append(heading);
      this.closeButton = button('Present', 'pe-button pe-button-quiet pe-close', () => this.toggle(false));
      this.closeButton.setAttribute('aria-label', 'Exit editor and present slides');
      header.append(titleBlock, this.closeButton);
      this.panel.append(header);

      var statusRow = element('div', 'pe-status-row');
      var dot = element('span', 'pe-status-dot');
      dot.setAttribute('aria-hidden', 'true');
      this.status = element('span', 'pe-status', 'Changes saved to this browser');
      this.status.setAttribute('role', 'status');
      this.status.setAttribute('aria-live', 'polite');
      statusRow.append(dot, this.status);
      this.panel.append(statusRow);

      var scrollArea = element('div', 'pe-scroll');
      this.panel.append(scrollArea);

      var history = element('div', 'pe-history');
      this.undoButton = button('Undo', 'pe-button pe-button-secondary', () => this.invoke('onUndo'));
      this.redoButton = button('Redo', 'pe-button pe-button-secondary', () => this.invoke('onRedo'));
      this.undoButton.disabled = true;
      this.redoButton.disabled = true;
      history.append(this.undoButton, this.redoButton);
      scrollArea.append(history);

      this.slideLabel = element('p', 'pe-slide-label', 'Current slide');
      scrollArea.append(this.slideLabel);
      this.itemsInput = element('select', 'pe-input');
      this.itemsInput.id = this.idPrefix + '-items';
      this.itemsInput.addEventListener('change', () => {
        if (this.itemsInput.value) this.invoke('onSelect', this.itemsInput.value);
      });
      scrollArea.append(field('Slide items', this.itemsInput, 'Select here or click an item on the slide.'));
      var selection = element('div', 'pe-selection');
      selection.append(element('span', 'pe-selection-caption', 'SELECTED ITEM'));
      this.selectionLabel = element('p', 'pe-selection-label', 'No item selected');
      selection.append(this.selectionLabel);
      scrollArea.append(selection);

      this.emptyState = element('p', 'pe-empty-state', 'Select an item on the slide to edit its text, image, or motion.');
      scrollArea.append(this.emptyState);

      this.tabs = element('div', 'pe-tabs');
      this.tabs.setAttribute('role', 'tablist');
      this.tabs.setAttribute('aria-label', 'Item settings');
      this.tabButtons = {};
      this.tabPanels = {};
      ['text', 'image', 'motion'].forEach((name) => {
        var tab = button(name.charAt(0).toUpperCase() + name.slice(1), 'pe-tab', () => this.activateTab(name, true));
        tab.id = this.idPrefix + '-tab-' + name;
        tab.setAttribute('role', 'tab');
        tab.setAttribute('aria-controls', this.idPrefix + '-settings-' + name);
        tab.setAttribute('aria-selected', 'false');
        tab.tabIndex = -1;
        tab.disabled = true;
        tab.addEventListener('keydown', (event) => this.navigateTabs(event, name));
        this.tabButtons[name] = tab;
        this.tabs.append(tab);
        var content = element('section', 'pe-tab-panel');
        content.id = this.idPrefix + '-settings-' + name;
        content.setAttribute('role', 'tabpanel');
        content.setAttribute('aria-labelledby', tab.id);
        content.hidden = true;
        this.tabPanels[name] = content;
      });
      scrollArea.append(this.tabs);
      Object.values(this.tabPanels).forEach((node) => scrollArea.append(node));
      this.buildTextPanel();
      this.buildImagePanel();
      this.buildMotionPanel();

      var sharing = element('section', 'pe-sharing');
      sharing.append(element('h3', 'pe-section-heading', 'Save & share'));
      this.sharingHelp = element('p', 'pe-help', 'Changes save to this browser. Update the shared link in two steps.');
      sharing.append(this.sharingHelp);
      var publishSteps = element('ol', 'pe-publish-steps');
      var downloadStep = element('li', 'pe-publish-step');
      downloadStep.append(element('h4', 'pe-step-heading', 'Download your edits'));
      this.downloadButton = button('Download updated index.html', 'pe-button pe-button-primary pe-full pe-download', () => this.invoke('onDownload'));
      downloadStep.append(this.downloadButton);
      downloadStep.append(element('p', 'pe-hint', 'Keep the filename index.html. If your browser adds a number, rename the file.'));
      var uploadStep = element('li', 'pe-publish-step');
      uploadStep.append(element('h4', 'pe-step-heading', 'Update the shared link'));
      this.githubUploadLink = element('a', 'pe-button pe-button-secondary pe-full pe-github-upload', 'Open GitHub upload');
      this.githubUploadLink.href = 'https://github.com/abody1217/acute-exercise-physiology/upload/main';
      this.githubUploadLink.target = '_blank';
      this.githubUploadLink.rel = 'noopener noreferrer';
      this.githubUploadLink.setAttribute('aria-label', 'Open GitHub upload in a new tab');
      uploadStep.append(this.githubUploadLink);
      uploadStep.append(element('p', 'pe-hint', 'Sign in with repository edit access. Replace index.html in the root folder, then commit changes to main. The shared link updates after deployment. Without GitHub access, send the downloaded index.html to the presentation owner to publish.'));
      publishSteps.append(downloadStep, uploadStep);
      sharing.append(publishSteps);
      var backupRow = element('div', 'pe-backup-row');
      backupRow.append(button('Export changes', 'pe-button pe-button-secondary', () => this.invoke('onExport')));
      this.importInput = element('input', 'pe-visually-hidden');
      this.importInput.type = 'file';
      this.importInput.accept = '.json,application/json';
      this.importInput.id = this.idPrefix + '-import';
      this.importInput.tabIndex = -1;
      this.importInput.setAttribute('aria-label', 'Choose presentation changes file');
      this.importInput.addEventListener('change', () => {
        var file = this.importInput.files && this.importInput.files[0];
        if (file) this.invoke('onImport', file);
        this.importInput.value = '';
      });
      backupRow.append(button('Import changes', 'pe-button pe-button-secondary', () => this.importInput.click()));
      sharing.append(backupRow, this.importInput);
      sharing.append(element('p', 'pe-hint', 'Export a backup to continue editing on another browser.'));
      this.resetButton = button('Reset all edits', 'pe-button pe-button-link pe-reset', () => this.showResetDialog());
      sharing.append(this.resetButton);
      scrollArea.append(sharing);

      this.buildResetDialog();
      this.escapeListener = (event) => {
        if (event.key !== 'Escape') return;
        if (!this.resetOverlay.hidden) {
          event.preventDefault();
          event.stopPropagation();
          this.hideResetDialog();
        } else if (this.open) {
          event.preventDefault();
          event.stopPropagation();
          this.toggle(false);
        }
      };
      document.addEventListener('keydown', this.escapeListener, true);
      document.body.append(this.root);
      this.render({});
    }

    invoke(name, ...args) {
      var callback = this.callbacks[name];
      if (typeof callback === 'function') return callback(...args);
    }

    buildTextPanel() {
      var content = this.tabPanels.text;
      this.textInput = element('textarea', 'pe-input pe-text-input');
      this.textInput.id = this.idPrefix + '-text';
      this.textInput.rows = 6;
      this.textInput.spellcheck = true;
      content.append(field('Text', this.textInput, 'Edit the words, then apply. Existing typography is preserved.'));
      this.applyTextButton = button('Apply text', 'pe-button pe-button-primary pe-full', () => this.invoke('onApplyText', this.textInput.value));
      content.append(this.applyTextButton);
    }

    buildImagePanel() {
      var content = this.tabPanels.image;
      this.imageInput = element('input', 'pe-file-input');
      this.imageInput.type = 'file';
      this.imageInput.id = this.idPrefix + '-image';
      this.imageInput.accept = 'image/png,image/jpeg,image/webp,image/gif';
      this.imageInput.addEventListener('change', () => {
        this.pendingImage = this.imageInput.files && this.imageInput.files[0] || null;
        this.applyImageButton.textContent = this.pendingImage ? 'Replace image' : 'Apply image description';
      });
      content.append(field('Replace image', this.imageInput, 'PNG, JPEG, WebP, or GIF. Choose an image, then apply.'));
      this.altInput = element('textarea', 'pe-input');
      this.altInput.id = this.idPrefix + '-alt';
      this.altInput.rows = 3;
      content.append(field('Image description', this.altInput, 'Describe what the image shows for people using a screen reader.'));
      this.applyImageButton = button('Apply image description', 'pe-button pe-button-primary pe-full', () => this.invoke('onReplaceImage', this.pendingImage, this.altInput.value));
      content.append(this.applyImageButton);
    }

    buildMotionPanel() {
      var content = this.tabPanels.motion;
      this.motionLabel = element('p', 'pe-motion-label', 'Applies to this item');
      content.append(this.motionLabel);
      this.effectInput = element('select', 'pe-input');
      this.effectInput.id = this.idPrefix + '-effect';
      var effects = [
        ['original', 'Original motion'], ['none', 'No motion'], ['fade', 'Fade in'],
        ['up', 'Move up'], ['down', 'Move down'], ['left', 'Move left'],
        ['right', 'Move right'], ['zoom', 'Zoom in'], ['pop', 'Pop in']
      ];
      effects.forEach(([value, label]) => {
        var option = element('option', '', label);
        option.value = value;
        this.effectInput.append(option);
      });
      content.append(field('Entrance effect', this.effectInput));
      var timingRow = element('div', 'pe-timing-row');
      this.durationInput = element('input', 'pe-input');
      this.durationInput.id = this.idPrefix + '-duration';
      this.durationInput.type = 'number';
      this.durationInput.required = true;
      this.durationInput.min = '100';
      this.durationInput.max = '10000';
      this.durationInput.step = '50';
      this.durationInput.value = '600';
      this.delayInput = element('input', 'pe-input');
      this.delayInput.id = this.idPrefix + '-delay';
      this.delayInput.type = 'number';
      this.delayInput.required = true;
      this.delayInput.min = '0';
      this.delayInput.max = '10000';
      this.delayInput.step = '50';
      this.delayInput.value = '0';
      timingRow.append(field('Duration (ms)', this.durationInput), field('Delay (ms)', this.delayInput));
      content.append(timingRow);
      content.append(element('p', 'pe-hint', '1,000 ms = 1 second. Original motion restores the presentation’s existing animation.'));
      this.applyMotionButton = button('Apply motion', 'pe-button pe-button-primary pe-full', () => {
        if (!this.durationInput.reportValidity() || !this.delayInput.reportValidity()) return;
        this.invoke('onApplyMotion', {
          effect: this.effectInput.value,
          duration: Number(this.durationInput.value),
          delay: Number(this.delayInput.value)
        });
      });
      this.previewButton = button('Replay motion', 'pe-button pe-button-secondary pe-full', () => this.invoke('onPreview'));
      content.append(this.applyMotionButton, this.previewButton);
    }

    buildResetDialog() {
      this.resetOverlay = element('div', 'pe-dialog-overlay');
      this.resetOverlay.hidden = true;
      var dialog = element('div', 'pe-dialog');
      dialog.setAttribute('role', 'alertdialog');
      dialog.setAttribute('aria-modal', 'true');
      dialog.setAttribute('aria-labelledby', this.idPrefix + '-reset-title');
      dialog.setAttribute('aria-describedby', this.idPrefix + '-reset-description');
      var title = element('h3', 'pe-dialog-heading', 'Reset all edits?');
      title.id = this.idPrefix + '-reset-title';
      var description = element('p', 'pe-help', 'This restores the original text, images, and motion on every slide. Export your changes first if you want a backup.');
      description.id = this.idPrefix + '-reset-description';
      var actions = element('div', 'pe-dialog-actions');
      this.cancelResetButton = button('Keep editing', 'pe-button pe-button-secondary', () => this.hideResetDialog());
      this.confirmResetButton = button('Reset edits', 'pe-button pe-button-danger', () => {
        this.hideResetDialog();
        this.invoke('onReset');
      });
      actions.append(this.cancelResetButton, this.confirmResetButton);
      dialog.append(title, description, actions);
      this.resetOverlay.append(dialog);
      this.resetOverlay.addEventListener('click', (event) => {
        if (event.target === this.resetOverlay) this.hideResetDialog();
      });
      dialog.addEventListener('keydown', (event) => {
        if (event.key !== 'Tab') return;
        var atStart = document.activeElement === this.cancelResetButton;
        var atEnd = document.activeElement === this.confirmResetButton;
        if (event.shiftKey && atStart) {
          event.preventDefault();
          this.confirmResetButton.focus();
        } else if (!event.shiftKey && atEnd) {
          event.preventDefault();
          this.cancelResetButton.focus();
        }
      });
      this.root.append(this.resetOverlay);
    }

    showResetDialog() {
      this.resetOverlay.hidden = false;
      this.panel.inert = true;
      this.launcher.inert = true;
      this.cancelResetButton.focus();
    }

    hideResetDialog() {
      this.resetOverlay.hidden = true;
      this.panel.inert = false;
      this.launcher.inert = false;
      if (this.open) this.resetButton.focus();
    }

    toggle(open) {
      this.setOpen(open);
      this.invoke('onToggle', this.open);
    }

    setOpen(open) {
      var wasOpen = this.open;
      this.open = Boolean(open);
      this.root.classList.toggle('pe-is-open', this.open);
      this.panel.hidden = !this.open;
      this.launcher.hidden = this.open;
      this.launcher.setAttribute('aria-expanded', String(this.open));
      if (!this.open && !this.resetOverlay.hidden) this.hideResetDialog();
      if (this.open && !wasOpen) this.closeButton.focus({preventScroll: true});
      if (!this.open && wasOpen) this.launcher.focus({preventScroll: true});
    }

    activateTab(name, focus) {
      if (!this.tabButtons[name] || this.tabButtons[name].disabled) return;
      this.activeTab = name;
      Object.keys(this.tabButtons).forEach((key) => {
        var active = key === name;
        this.tabButtons[key].setAttribute('aria-selected', String(active));
        this.tabButtons[key].tabIndex = active ? 0 : -1;
        this.tabPanels[key].hidden = !active;
      });
      if (focus) this.tabButtons[name].focus();
    }

    navigateTabs(event, name) {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      var enabled = Object.keys(this.tabButtons).filter((key) => !this.tabButtons[key].disabled);
      if (!enabled.length) return;
      event.preventDefault();
      var next = enabled.indexOf(name);
      if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = enabled.length - 1;
      else next = (next + (event.key === 'ArrowRight' ? 1 : -1) + enabled.length) % enabled.length;
      this.activateTab(enabled[next], true);
    }

    render(state) {
      this.state = Object.assign({}, this.state || {}, state || {});
      state = this.state;
      var selected = state.selected || null;
      var previousId = this.selected && this.selected.id;
      this.selected = selected;
      setText(this.slideLabel, state.slideLabel || 'Current slide');
      setText(this.selectionLabel, selected ? (selected.label || (selected.type === 'image' ? 'Image' : selected.type === 'motion' ? 'Motion group' : 'Text')) : 'No item selected');
      setText(this.status, state.status || 'Changes saved to this browser');
      this.root.classList.toggle('pe-status-error', state.statusKind === 'error' || Boolean(state.error));
      this.undoButton.disabled = !state.canUndo;
      this.redoButton.disabled = !state.canRedo;
      this.root.classList.toggle('pe-has-edits', Boolean(state.dirty));
      this.emptyState.hidden = Boolean(selected);
      this.tabs.hidden = !selected;
      this.tabButtons.text.disabled = !selected || selected.type !== 'text';
      this.tabButtons.image.disabled = !selected || selected.type !== 'image';
      this.tabButtons.motion.disabled = !selected;
      var items = Array.isArray(state.items) ? state.items : [];
      var itemsSignature = JSON.stringify(items.map((item) => [item.id, item.label, item.type]));
      if (itemsSignature !== this.lastItemsSignature) {
        this.itemsInput.replaceChildren();
        var placeholder = element('option', '', 'Select an item…');
        placeholder.value = '';
        this.itemsInput.append(placeholder);
        items.forEach((item) => {
          var label = item.label || (item.type === 'image' ? 'Image' : item.type === 'motion' ? 'Motion group' : 'Text');
          var option = element('option', '', label);
          option.value = item.id;
          this.itemsInput.append(option);
        });
        this.lastItemsSignature = itemsSignature;
      }
      this.itemsInput.disabled = !items.length;
      this.itemsInput.value = selected ? selected.id : '';

      if (!selected) {
        Object.values(this.tabPanels).forEach((panel) => { panel.hidden = true; });
        this.lastSelectionSignature = '';
        return;
      }

      var signature = JSON.stringify([selected.id, selected.type, selected.text, selected.alt, selected.motion]);
      setText(this.motionLabel, selected.motionLabel || 'Applies to this item');
      if (signature !== this.lastSelectionSignature) {
        this.textInput.value = selected.text || '';
        this.altInput.value = selected.alt || '';
        var motion = selected.motion || {};
        this.effectInput.value = motion.effect || 'original';
        if (!this.effectInput.value) this.effectInput.value = 'original';
        this.durationInput.value = Number.isFinite(motion.duration) ? motion.duration : 600;
        this.delayInput.value = Number.isFinite(motion.delay) ? motion.delay : 0;
        this.imageInput.value = '';
        this.pendingImage = null;
        this.applyImageButton.textContent = 'Apply image description';
        this.lastSelectionSignature = signature;
      }
      var nextTab = this.activeTab;
      if (selected.id !== previousId || this.tabButtons[nextTab].disabled) {
        nextTab = selected.type === 'text' ? 'text' : selected.type === 'image' ? 'image' : 'motion';
      }
      this.activateTab(nextTab, false);
    }

    destroy() {
      document.removeEventListener('keydown', this.escapeListener, true);
      this.root.remove();
    }
  }

  window.PresentationEditorUI = PresentationEditorUI;
})();
