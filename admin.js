(function () {
  'use strict';

  const CFG = window.APP_CONFIG || {};
  const API = CFG.API_BASE_URL || 'http://localhost:8000';
  const WS_URL = CFG.WS_URL || API.replace(/^http/, 'ws') + '/ws/organizers';
  const SITES = CFG.EVENT_SITES || [{ key: 'eventu', label: 'Eventu' }, { key: 'campus', label: 'Campus' }];

  const state = {
    token: localStorage.getItem('eventu_staff_token') || '',
    username: localStorage.getItem('eventu_staff_name') || '',
    role: localStorage.getItem('eventu_staff_role') || '',
    ws: null,
    wsReconnect: null,
    bookings: [],
    events: [],
    categories: [],
    staff: [],
  };

  const $ = (id) => document.getElementById(id);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const esc = (value) => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  function iconify() {
    if (window.lucide) window.lucide.createIcons();
  }

  function setBusy(isBusy) {
    $('sync-indicator')?.classList.toggle('hidden', !isBusy);
  }

  function toast(message, kind = 'info') {
    const container = $('toast-container');
    if (!container) return;

    const item = document.createElement('div');
    item.className = `toast toast-${kind}`;
    item.textContent = message;
    container.appendChild(item);
    window.setTimeout(() => item.remove(), 3600);
  }

  async function api(path, options = {}) {
    const { method = 'GET', body = null, auth = true, raw = false } = options;
    const headers = {};

    if (!raw) headers['Content-Type'] = 'application/json';
    if (auth && state.token) headers.Authorization = `Bearer ${state.token}`;

    const response = await fetch(`${API}${path}`, {
      method,
      headers,
      body: raw ? body : body ? JSON.stringify(body) : null,
    });

    if (response.status === 401) {
      logout();
      throw new Error('unauthorized');
    }

    return response;
  }

  async function readJson(response, fallback) {
    try {
      return await response.json();
    } catch {
      return fallback;
    }
  }

  function showLoginError(message) {
    $('login-error-text').textContent = message;
    $('login-error').style.display = 'flex';
  }

  async function login() {
    const username = $('login-name').value.trim();
    const password = $('login-password').value;

    $('login-error').style.display = 'none';
    if (!username || !password) {
      showLoginError('Enter username and password.');
      return;
    }

    setBusy(true);
    try {
      const response = await fetch(`${API}/auth/staff/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });

      if (!response.ok) {
        showLoginError(response.status === 401 ? 'Invalid credentials.' : `Login error ${response.status}.`);
        return;
      }

      const data = await response.json();
      state.token = data.access_token;
      state.username = data.username || username;
      state.role = data.role || '';

      localStorage.setItem('eventu_staff_token', state.token);
      localStorage.setItem('eventu_staff_name', state.username);
      localStorage.setItem('eventu_staff_role', state.role);

      enterDashboard();
    } catch {
      showLoginError('Server unavailable. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  function logout() {
    state.token = '';
    state.username = '';
    state.role = '';

    localStorage.removeItem('eventu_staff_token');
    localStorage.removeItem('eventu_staff_name');
    localStorage.removeItem('eventu_staff_role');

    if (state.ws) {
      try { state.ws.close(); } catch {}
      state.ws = null;
    }

    $('dashboard').classList.add('hidden');
    $('login-overlay').style.display = 'flex';
    setConnection(false);
  }

  function enterDashboard() {
    $('login-overlay').style.display = 'none';
    $('dashboard').classList.remove('hidden');
    $('manager-display-name').textContent = state.username;
    $('manager-avatar').textContent = (state.username[0] || '?').toUpperCase();
    $('tab-btn-team').classList.toggle('hidden', !canManageTeam());
    connectWS();
    refreshAll();
    iconify();
  }

  function canManageTeam() {
    return state.role === 'super_admin' || state.role === 'admin';
  }

  async function refreshAll() {
    setBusy(true);
    await Promise.all([fetchCategories(), fetchEvents(), fetchBookings()]);
    setBusy(false);
  }

  function setConnection(isConnected) {
    const badge = $('connection-badge');
    if (!badge) return;
    badge.classList.toggle('connected', isConnected);
    badge.classList.toggle('disconnected', !isConnected);
    $('connection-label').textContent = isConnected ? 'Live' : 'Offline';
  }

  function connectWS() {
    if (state.ws) {
      try { state.ws.close(); } catch {}
    }

    try {
      state.ws = new WebSocket(WS_URL);
    } catch {
      setConnection(false);
      return;
    }

    state.ws.onopen = () => state.ws.send(JSON.stringify({ action: 'auth', token: state.token }));
    state.ws.onmessage = (event) => {
      let message = {};
      try { message = JSON.parse(event.data); } catch { return; }

      if (message.action === 'auth_ok') {
        setConnection(true);
        return;
      }

      if (message.action === 'error') {
        toast(message.message || 'WebSocket error', 'error');
        return;
      }

      const name = String(message.event || '');
      if (name === 'new_booking' || name.startsWith('booking')) fetchBookings();
    };
    state.ws.onerror = () => setConnection(false);
    state.ws.onclose = () => {
      setConnection(false);
      scheduleReconnect();
    };
  }

  function scheduleReconnect() {
    if (state.wsReconnect || !state.token) return;
    state.wsReconnect = window.setTimeout(() => {
      state.wsReconnect = null;
      if (state.token) connectWS();
    }, 5000);
  }

  async function fetchBookings() {
    try {
      const response = await api('/bookings?limit=500');
      state.bookings = response.ok ? await response.json() : [];
    } catch (error) {
      if (String(error.message) !== 'unauthorized') console.warn('fetchBookings', error);
    }
    renderBookings();
  }

  function getEventTitle(eventId) {
    const event = state.events.find((item) => String(item.id) === String(eventId));
    return event?.title?.en || event?.title?.ua || eventId || '-';
  }

  function bookingCard(booking) {
    const actions = [];

    if (booking.status === 'pending') {
      actions.push(`<button data-act="confirm" data-id="${esc(booking.id)}" class="btn-mini success" type="button">Confirm</button>`);
      actions.push(`<button data-act="cancel" data-id="${esc(booking.id)}" class="btn-mini danger" type="button">Cancel</button>`);
    }

    if (booking.status === 'confirmed') {
      actions.push(`<button data-act="checkin" data-id="${esc(booking.id)}" class="btn-mini success" type="button">Check-in</button>`);
      actions.push(`<button data-act="cancel" data-id="${esc(booking.id)}" class="btn-mini danger" type="button">Cancel</button>`);
    }

    return `
      <article class="job-card booking-card">
        <div class="card-topline">
          <h3>${esc(getEventTitle(booking.event_id))}</h3>
          <span class="ticket-code">${esc(booking.ticket_code || '')}</span>
        </div>
        <p>${esc(booking.student_name)} · x${esc(booking.quantity)}</p>
        <p>${esc(booking.email || booking.phone || '-')}</p>
        ${booking.comment ? `<blockquote>${esc(booking.comment)}</blockquote>` : ''}
        ${actions.length ? `<div class="job-actions">${actions.join('')}</div>` : ''}
      </article>`;
  }

  function renderBookings() {
    const columns = { pending: [], confirmed: [], checked_in: [] };
    state.bookings.forEach((booking) => {
      if (columns[booking.status]) columns[booking.status].push(booking);
    });

    Object.entries(columns).forEach(([status, items]) => {
      const column = $(`col-${status}`);
      const count = $(`count-${status}`);
      if (count) count.textContent = items.length;
      if (!column) return;
      column.innerHTML = items.length
        ? items.map(bookingCard).join('')
        : '<div class="empty-state">No bookings</div>';
    });

    $('total-count').textContent = state.bookings.length;
    $$('.column-cards [data-act]').forEach((button) => {
      button.addEventListener('click', () => bookingAction(button.dataset.act, button.dataset.id));
    });
    iconify();
  }

  async function bookingAction(action, id) {
    setBusy(true);
    try {
      const response = await api(`/bookings/${id}/${action}`, { method: 'POST' });
      const data = await readJson(response, {});
      if (!response.ok) {
        toast(data.detail || `Could not ${action}.`, 'error');
      } else {
        toast(action === 'checkin' ? 'Booking checked in.' : `Booking ${action}ed.`, 'success');
      }
    } catch (error) {
      if (String(error.message) !== 'unauthorized') toast('Action failed.', 'error');
    } finally {
      await fetchBookings();
      setBusy(false);
    }
  }

  async function fetchEvents() {
    try {
      const response = await fetch(`${API}/events`);
      state.events = response.ok ? await response.json() : [];
    } catch {
      state.events = [];
    }
    renderEvents();
  }

  function visibleEvents() {
    if (state.role === 'super_admin' || state.role === 'admin') return state.events;
    return state.events.filter((event) => event.owner === state.username);
  }

  function renderEvents() {
    const list = $('events-list');
    const events = visibleEvents();
    $('events-total-count').textContent = events.length;

    if (!events.length) {
      list.innerHTML = '<div class="empty-state">No events yet.</div>';
      return;
    }

    list.innerHTML = events.map((event) => {
      const title = event.title?.en || event.title?.ua || '';
      const seats = event.seats_available === null || event.seats_available === undefined
        ? 'unlimited'
        : `${event.seats_available}/${event.capacity} left`;

      return `
        <article class="event-card">
          <div>
            <div class="card-topline">
              <h3>${esc(title)}</h3>
              <span class="status-badge">${esc(event.type || 'event')}</span>
            </div>
            <p>${esc(event.venue || '-')} · ${esc(event.starts_at || '-')}</p>
            <p>${esc(event.price || 'Free')} · ${esc(seats)}${event.owner ? ` · by ${esc(event.owner)}` : ''}</p>
          </div>
          <div class="card-controls">
            <button data-edit-event="${esc(event.id)}" class="icon-btn" type="button" aria-label="Edit event"><i data-lucide="pencil"></i></button>
            <button data-del-event="${esc(event.id)}" class="icon-btn danger" type="button" aria-label="Delete event"><i data-lucide="trash-2"></i></button>
          </div>
        </article>`;
    }).join('');

    $$('[data-edit-event]', list).forEach((button) => button.addEventListener('click', () => openEventModal(button.dataset.editEvent)));
    $$('[data-del-event]', list).forEach((button) => button.addEventListener('click', () => deleteEvent(button.dataset.delEvent)));
    iconify();
  }

  function populateEventOptions() {
    $('event-type').innerHTML = state.categories
      .map((category) => `<option value="${esc(category.id)}">${esc(category.label?.en || category.label?.ua || category.id)}</option>`)
      .join('');

    $('event-sites').innerHTML = SITES
      .map((site) => `
        <label class="job-checkbox">
          <input type="checkbox" data-site="${esc(site.key)}">
          <span>${esc(site.label)}</span>
        </label>`)
      .join('');
  }

  function toLocalInput(value) {
    const date = new Date(String(value).replace(' ', 'T'));
    if (Number.isNaN(date.getTime())) return '';
    const pad = (number) => String(number).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function openEventModal(eventId = null) {
    populateEventOptions();

    const event = eventId ? state.events.find((item) => String(item.id) === String(eventId)) : null;
    $('event-form-error').style.display = 'none';
    $('event-modal-title').textContent = event ? 'Edit Event' : 'Add Event';
    $('event-id').value = event?.id || '';
    $('event-title-ua').value = event?.title?.ua || '';
    $('event-title-en').value = event?.title?.en || '';
    $('event-type').value = event?.type || $('event-type').value;
    $('event-venue').value = event?.venue || '';
    $('event-starts-at').value = event?.starts_at ? toLocalInput(event.starts_at) : '';
    $('event-price').value = event?.price || '';
    $('event-capacity').value = event?.capacity || 0;
    $('event-tags').value = Array.isArray(event?.tags) ? event.tags.join(', ') : '';
    $('event-group').value = event?.telegram_group_id || '';
    $('event-description').value = event?.description || '';
    $('event-is-featured').checked = event ? Boolean(event.featured) : true;
    $('event-image').value = '';

    const sites = event?.sites || [];
    $$('#event-sites [data-site]').forEach((checkbox) => {
      checkbox.checked = sites.includes(checkbox.dataset.site);
    });

    $('event-modal-overlay').classList.remove('hidden');
    iconify();
  }

  function closeEventModal() {
    $('event-modal-overlay').classList.add('hidden');
  }

  function showFormError(id, message) {
    const element = $(id);
    element.textContent = message;
    element.style.display = 'block';
  }

  async function saveEvent(event) {
    event.preventDefault();
    const id = $('event-id').value;
    const startsAt = $('event-starts-at').value;
    const sites = $$('#event-sites [data-site]')
      .filter((checkbox) => checkbox.checked)
      .map((checkbox) => checkbox.dataset.site);

    const payload = {
      title_ua: $('event-title-ua').value.trim(),
      title_en: $('event-title-en').value.trim(),
      type: $('event-type').value,
      venue: $('event-venue').value.trim() || null,
      starts_at: startsAt ? new Date(startsAt).toISOString() : null,
      price: $('event-price').value.trim() || null,
      capacity: Math.max(0, parseInt($('event-capacity').value || '0', 10)),
      tags: $('event-tags').value.split(',').map((tag) => tag.trim()).filter(Boolean),
      telegram_group_id: $('event-group').value.trim() || null,
      description: $('event-description').value.trim() || null,
      is_featured: $('event-is-featured').checked,
      sites,
    };

    if (!payload.title_ua || !payload.title_en || !payload.type) {
      showFormError('event-form-error', 'Titles and category are required.');
      return;
    }

    setBusy(true);
    try {
      const response = await api(id ? `/events/${id}` : '/events', {
        method: id ? 'PUT' : 'POST',
        body: payload,
      });
      const data = await readJson(response, {});

      if (!response.ok) {
        showFormError('event-form-error', data.detail || `Error ${response.status}.`);
        return;
      }

      const eventId = id || data.id;
      const image = $('event-image').files[0];
      if (image && eventId) await uploadEventImage(eventId, image);

      toast('Event saved.', 'success');
      closeEventModal();
      await fetchEvents();
    } catch (error) {
      if (String(error.message) !== 'unauthorized') showFormError('event-form-error', 'Save failed.');
    } finally {
      setBusy(false);
    }
  }

  async function uploadEventImage(eventId, file) {
    const body = new FormData();
    body.append('file', file);

    const response = await api(`/events/${eventId}/image`, { method: 'POST', body, raw: true });
    if (!response.ok) toast('Image upload failed.', 'error');
  }

  async function deleteEvent(id) {
    if (!confirm('Delete this event?')) return;
    setBusy(true);
    try {
      const response = await api(`/events/${id}`, { method: 'DELETE' });
      if (!response.ok) {
        toast('Delete failed.', 'error');
        return;
      }
      toast('Event deleted.', 'success');
      await fetchEvents();
    } catch (error) {
      if (String(error.message) !== 'unauthorized') toast('Delete failed.', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function fetchCategories() {
    try {
      const response = await fetch(`${API}/categories`);
      state.categories = response.ok ? await response.json() : [];
    } catch {
      state.categories = [];
    }
    renderCategories();
  }

  function renderCategories() {
    const list = $('categories-list');
    $('categories-total-count').textContent = state.categories.length;

    if (!state.categories.length) {
      list.innerHTML = '<div class="empty-state">No categories.</div>';
      return;
    }

    list.innerHTML = state.categories.map((category) => `
      <article class="category-card">
        <div>
          <div class="card-topline">
            <h3>${esc(category.label?.en || category.id)}</h3>
            <span class="status-badge">${esc(category.id)}</span>
          </div>
          <p>${esc(category.label?.ua || '')}</p>
        </div>
        <div class="card-controls">
          <button data-edit-cat="${esc(category.id)}" class="icon-btn" type="button" aria-label="Edit category"><i data-lucide="pencil"></i></button>
          <button data-del-cat="${esc(category.id)}" class="icon-btn danger" type="button" aria-label="Delete category"><i data-lucide="trash-2"></i></button>
        </div>
      </article>`).join('');

    $$('[data-edit-cat]', list).forEach((button) => button.addEventListener('click', () => openCategoryModal(button.dataset.editCat)));
    $$('[data-del-cat]', list).forEach((button) => button.addEventListener('click', () => deleteCategory(button.dataset.delCat)));
    iconify();
  }

  function openCategoryModal(categoryId = null) {
    const category = categoryId ? state.categories.find((item) => item.id === categoryId) : null;
    $('category-form-error').style.display = 'none';
    $('category-modal-title').textContent = category ? 'Edit Category' : 'Add Category';
    $('category-id').value = category?.id || '';
    $('category-label-ua').value = category?.label?.ua || '';
    $('category-label-en').value = category?.label?.en || '';
    $('category-modal-overlay').classList.remove('hidden');
  }

  function closeCategoryModal() {
    $('category-modal-overlay').classList.add('hidden');
  }

  async function saveCategory(event) {
    event.preventDefault();
    const id = $('category-id').value;
    const payload = {
      label_ua: $('category-label-ua').value.trim(),
      label_en: $('category-label-en').value.trim(),
    };

    if (!payload.label_ua || !payload.label_en) {
      showFormError('category-form-error', 'Both labels are required.');
      return;
    }

    setBusy(true);
    try {
      const response = await api(id ? `/categories/${id}` : '/categories', {
        method: id ? 'PUT' : 'POST',
        body: payload,
      });
      const data = await readJson(response, {});

      if (!response.ok) {
        showFormError('category-form-error', data.detail || `Error ${response.status}.`);
        return;
      }

      toast('Category saved.', 'success');
      closeCategoryModal();
      await fetchCategories();
    } catch (error) {
      if (String(error.message) !== 'unauthorized') showFormError('category-form-error', 'Save failed.');
    } finally {
      setBusy(false);
    }
  }

  async function deleteCategory(id) {
    if (!confirm('Delete this category?')) return;
    setBusy(true);
    try {
      const response = await api(`/categories/${id}`, { method: 'DELETE' });
      const data = await readJson(response, {});

      if (!response.ok) {
        toast(data.detail || 'Delete failed.', 'error');
        return;
      }

      toast('Category deleted.', 'success');
      await fetchCategories();
    } catch (error) {
      if (String(error.message) !== 'unauthorized') toast('Delete failed.', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function fetchStaff() {
    try {
      const response = await api('/staff');
      state.staff = response.ok ? await response.json() : [];
    } catch {
      state.staff = [];
    }
    renderStaff();
  }

  function renderStaff() {
    const list = $('staff-list');
    if (!list) return;
    $('staff-total-count').textContent = state.staff.length;

    if (!state.staff.length) {
      list.innerHTML = '<div class="empty-state">No staff.</div>';
      return;
    }

    list.innerHTML = state.staff.map((person) => {
      const canDelete = person.username !== state.username && (state.role === 'super_admin' || person.role === 'organizer');
      const badge = person.role === 'super_admin' ? 'Super-admin' : person.role === 'admin' ? 'Admin' : 'Organizer';
      return `
        <article class="staff-card">
          <div>
            <div class="card-topline">
              <h3>${esc(person.username)}</h3>
              <span class="status-badge">${esc(badge)}</span>
            </div>
            <p>${esc(person.full_name || '-')} ${person.created_by ? `· created by ${esc(person.created_by)}` : ''}</p>
          </div>
          <div class="card-controls">
            ${canDelete ? `<button data-del-staff="${esc(person.id)}" class="icon-btn danger" type="button" aria-label="Delete staff"><i data-lucide="trash-2"></i></button>` : ''}
          </div>
        </article>`;
    }).join('');

    $$('[data-del-staff]', list).forEach((button) => button.addEventListener('click', () => deleteStaff(button.dataset.delStaff)));
    iconify();
  }

  function openStaffModal() {
    $('staff-form-error').style.display = 'none';
    $('staff-username').value = '';
    $('staff-password').value = '';
    $('staff-fullname').value = '';
    $('staff-role').innerHTML = state.role === 'super_admin'
      ? '<option value="organizer">Organizer</option><option value="admin">Admin</option>'
      : '<option value="organizer">Organizer</option>';
    $('staff-modal-overlay').classList.remove('hidden');
  }

  function closeStaffModal() {
    $('staff-modal-overlay').classList.add('hidden');
  }

  async function saveStaff(event) {
    event.preventDefault();
    const payload = {
      username: $('staff-username').value.trim(),
      password: $('staff-password').value,
      full_name: $('staff-fullname').value.trim() || null,
      role: $('staff-role').value,
    };

    if (!payload.username || payload.password.length < 6) {
      showFormError('staff-form-error', 'Username and a password of at least 6 characters are required.');
      return;
    }

    setBusy(true);
    try {
      const response = await api('/staff', { method: 'POST', body: payload });
      const data = await readJson(response, {});

      if (!response.ok) {
        showFormError('staff-form-error', data.detail || `Error ${response.status}.`);
        return;
      }

      toast('Organizer created.', 'success');
      closeStaffModal();
      await fetchStaff();
    } catch (error) {
      if (String(error.message) !== 'unauthorized') showFormError('staff-form-error', 'Save failed.');
    } finally {
      setBusy(false);
    }
  }

  async function deleteStaff(id) {
    if (!confirm('Delete this staff account?')) return;
    setBusy(true);
    try {
      const response = await api(`/staff/${id}`, { method: 'DELETE' });
      const data = await readJson(response, {});

      if (!response.ok) {
        toast(data.detail || 'Delete failed.', 'error');
        return;
      }

      toast('Staff deleted.', 'success');
      await fetchStaff();
    } catch (error) {
      if (String(error.message) !== 'unauthorized') toast('Delete failed.', 'error');
    } finally {
      setBusy(false);
    }
  }

  function showCheckinResult(message, ok) {
    const element = $('checkin-result');
    if (!element) return;
    element.textContent = message;
    element.className = ok ? 'ok' : 'bad';
  }

  async function checkinByCode() {
    const code = $('checkin-code').value.trim().toUpperCase();
    if (!code) {
      showCheckinResult('Enter a ticket code.', false);
      return;
    }

    showCheckinResult('Checking...', true);
    try {
      const response = await api('/bookings/checkin-by-code', {
        method: 'POST',
        body: { ticket_code: code },
      });
      const data = await readJson(response, {});

      if (!response.ok) {
        showCheckinResult(data.detail || `Error ${response.status}.`, false);
        return;
      }

      showCheckinResult(`${data.message || 'Done'}${data.student_name ? ` - ${data.student_name}` : ''}`, Boolean(data.ok));
      if (data.ok) {
        $('checkin-code').value = '';
        await fetchBookings();
      }
    } catch (error) {
      if (String(error.message) !== 'unauthorized') showCheckinResult('Check-in failed.', false);
    }
  }

  function showTab(tabName) {
    $$('.tab-btn').forEach((button) => button.classList.toggle('active', button.dataset.tab === tabName));
    $$('.tab-panel').forEach((panel) => panel.classList.add('hidden'));
    $(`tab-${tabName}`).classList.remove('hidden');
    if (tabName === 'team') fetchStaff();
  }

  function initTabs() {
    $$('.tab-btn').forEach((button) => {
      button.addEventListener('click', () => showTab(button.dataset.tab));
    });
  }

  function initClock() {
    const tick = () => {
      $('clock').textContent = new Date().toLocaleTimeString();
    };
    tick();
    window.setInterval(tick, 1000);
  }

  function bindModalDismiss() {
    [
      ['event-modal-overlay', closeEventModal],
      ['category-modal-overlay', closeCategoryModal],
      ['staff-modal-overlay', closeStaffModal],
    ].forEach(([id, close]) => {
      $(id).addEventListener('click', (event) => {
        if (event.target.id === id) close();
      });
    });
  }

  function bindEvents() {
    $('btn-login').addEventListener('click', login);
    $('login-password').addEventListener('keydown', (event) => { if (event.key === 'Enter') login(); });
    $('login-name').addEventListener('keydown', (event) => { if (event.key === 'Enter') login(); });
    $('btn-logout').addEventListener('click', logout);
    $('btn-refresh').addEventListener('click', refreshAll);

    $('btn-add-event').addEventListener('click', () => openEventModal());
    $('event-form').addEventListener('submit', saveEvent);
    $('event-cancel').addEventListener('click', closeEventModal);
    $('event-modal-close').addEventListener('click', closeEventModal);

    $('btn-add-category').addEventListener('click', () => openCategoryModal());
    $('category-form').addEventListener('submit', saveCategory);
    $('category-cancel').addEventListener('click', closeCategoryModal);
    $('category-modal-close').addEventListener('click', closeCategoryModal);

    $('btn-add-staff').addEventListener('click', openStaffModal);
    $('staff-form').addEventListener('submit', saveStaff);
    $('staff-cancel').addEventListener('click', closeStaffModal);
    $('staff-modal-close').addEventListener('click', closeStaffModal);

    $('btn-checkin-code').addEventListener('click', checkinByCode);
    $('checkin-code').addEventListener('keydown', (event) => { if (event.key === 'Enter') checkinByCode(); });

    bindModalDismiss();
  }

  document.addEventListener('DOMContentLoaded', () => {
    iconify();
    initTabs();
    initClock();
    bindEvents();

    if (state.token) enterDashboard();
    else $('login-overlay').style.display = 'flex';
  });
})();
