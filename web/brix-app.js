    // Config
    const API_BASE = window.location.origin;

    // State
    let currentType = 'phone';
    let currentUserId = null;
    let devCode = null;
    let resendCountdown = 45;
    let timerInterval = null;
    let usernameTimer = null;
    let usernameAvailable = false;

    function selectType(type) {
      currentType = type;
      document.getElementById('btnPhone').classList.toggle('active', type === 'phone');
      document.getElementById('btnEmail').classList.toggle('active', type === 'email');
      document.getElementById('phoneGroup').classList.toggle('hidden', type !== 'phone');
      document.getElementById('emailGroup').classList.toggle('hidden', type !== 'email');
    }

    function onUsernameInput() {
      const raw = document.getElementById('usernameInput').value.toLowerCase().replace(/[^a-z0-9_]/g, '');
      document.getElementById('usernameInput').value = raw;

      const previewEl = document.getElementById('previewAddress');
      const statusEl = document.getElementById('usernameStatus');
      const submitBtn = document.getElementById('submitBtn');

      if (raw.length < 3) {
        previewEl.textContent = raw.length > 0 ? raw + '@brix.app' : '...@brix.app';
        statusEl.textContent = raw.length > 0 ? 'Mínimo 3 caracteres' : '';
        statusEl.style.color = 'var(--text-muted)';
        submitBtn.disabled = true;
        usernameAvailable = false;
        return;
      }

      previewEl.textContent = raw + '@brix.app';
      statusEl.textContent = 'Verificando...';
      statusEl.style.color = 'var(--text-muted)';

      if (usernameTimer) clearTimeout(usernameTimer);
      usernameTimer = setTimeout(async () => {
        try {
          const resp = await fetch(`${API_BASE}/brix/check-username/${encodeURIComponent(raw)}`);
          const data = await resp.json();
          if (data.available) {
            statusEl.textContent = '✓ Disponível';
            statusEl.style.color = 'var(--green)';
            submitBtn.disabled = false;
            usernameAvailable = true;
          } else {
            statusEl.textContent = '✗ ' + (data.error || 'Já em uso');
            statusEl.style.color = '#f87171';
            submitBtn.disabled = true;
            usernameAvailable = false;
          }
        } catch (e) {
          statusEl.textContent = 'Erro de conexão';
          statusEl.style.color = '#f87171';
          submitBtn.disabled = true;
          usernameAvailable = false;
        }
      }, 500);
    }

    function showError(msg) {
      alert(msg);
    }

    async function submitRegistration() {
      const submitBtn = document.getElementById('submitBtn');
      const username = document.getElementById('usernameInput').value.toLowerCase().trim();

      if (!usernameAvailable || username.length < 3) {
        showError('Escolha um username disponível');
        return;
      }

      let identifier;
      if (currentType === 'phone') {
        identifier = document.getElementById('phoneInput').value.trim();
      } else {
        identifier = document.getElementById('emailInput').value.trim();
      }

      if (!identifier) {
        showError(currentType === 'phone' ? 'Informe seu celular' : 'Informe seu email');
        return;
      }

      submitBtn.disabled = true;
      submitBtn.textContent = 'Registrando...';

      try {
        const resp = await fetch(`${API_BASE}/brix/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: username,
            ...(currentType === 'phone' ? { phone: identifier } : { email: identifier }),
          }),
        });

        const data = await resp.json();

        if (!resp.ok) {
          showError(data.error || 'Erro ao registrar');
          submitBtn.disabled = false;
          submitBtn.textContent = 'Criar meu BRIX →';
          return;
        }

        currentUserId = data.user_id;
        devCode = data.dev_code || null;

        // Show verification step
        document.getElementById('verifyDestination').textContent = identifier;
        document.getElementById('step1').classList.add('hidden');
        document.getElementById('step2').classList.remove('hidden');

        // Show dev code hint if in dev mode
        if (devCode) {
          document.getElementById('devCodeHint').textContent = `Código DEV: ${devCode}`;
          document.getElementById('devCodeHint').classList.remove('hidden');
        }

        // Focus first digit
        document.querySelector('.brix-code-digit[data-index="0"]').focus();

        // Start resend timer
        startResendTimer();

      } catch (err) {
        showError('Erro de conexão com o servidor');
        submitBtn.disabled = false;
        submitBtn.textContent = 'Criar meu BRIX →';
      }
    }

    function startResendTimer() {
      resendCountdown = 45;
      updateResendTimer();
      if (timerInterval) clearInterval(timerInterval);
      timerInterval = setInterval(() => {
        resendCountdown--;
        updateResendTimer();
        if (resendCountdown <= 0) clearInterval(timerInterval);
      }, 1000);
    }

    function updateResendTimer() {
      const el = document.getElementById('resendTimer');
      const link = document.getElementById('resendLink');
      if (resendCountdown > 0) {
        el.textContent = resendCountdown;
        link.classList.remove('active');
        link.onclick = null;
      } else {
        link.textContent = 'Reenviar código';
        link.classList.add('active');
        link.onclick = resendCode;
      }
    }

    async function resendCode() {
      if (!currentUserId) return;
      try {
        const resp = await fetch(`${API_BASE}/brix/resend`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ user_id: currentUserId }),
        });
        const data = await resp.json();
        if (data.dev_code) {
          devCode = data.dev_code;
          document.getElementById('devCodeHint').textContent = `Código DEV: ${devCode}`;
          document.getElementById('devCodeHint').classList.remove('hidden');
        }
        const link = document.getElementById('resendLink');
        link.innerHTML = 'Reenviar código (<span id="resendTimer">45</span>s)';
        startResendTimer();
      } catch (err) {
        showError('Erro ao reenviar código');
      }
    }

    function onCodeInput(el) {
      const val = el.value.replace(/\D/g, '');
      el.value = val ? val[0] : '';

      if (val) {
        const idx = parseInt(el.dataset.index);
        if (idx < 5) {
          const next = document.querySelector(`.brix-code-digit[data-index="${idx + 1}"]`);
          if (next) next.focus();
        }
      }

      checkCodeComplete();
    }

    function onCodeKeydown(e, el) {
      if (e.key === 'Backspace' && !el.value) {
        const idx = parseInt(el.dataset.index);
        if (idx > 0) {
          const prev = document.querySelector(`.brix-code-digit[data-index="${idx - 1}"]`);
          if (prev) { prev.focus(); prev.value = ''; }
        }
      }
    }

    function checkCodeComplete() {
      const digits = document.querySelectorAll('.brix-code-digit');
      let code = '';
      digits.forEach(d => code += d.value);
      document.getElementById('verifyBtn').disabled = code.length < 6;
    }

    async function verifyCode() {
      const verifyBtn = document.getElementById('verifyBtn');
      verifyBtn.disabled = true;
      verifyBtn.textContent = 'Verificando...';

      const digits = document.querySelectorAll('.brix-code-digit');
      let code = '';
      digits.forEach(d => code += d.value);

      try {
        const resp = await fetch(`${API_BASE}/brix/verify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ user_id: currentUserId, code: code }),
        });

        const data = await resp.json();

        if (!resp.ok) {
          showError(data.error || 'Código inválido');
          verifyBtn.disabled = false;
          verifyBtn.textContent = 'Verificar →';
          return;
        }

        // Success!
        document.getElementById('successAddress').textContent = data.brix_address;
        document.getElementById('step2').classList.add('hidden');
        document.getElementById('step3').classList.remove('hidden');

        if (timerInterval) clearInterval(timerInterval);

      } catch (err) {
        showError('Erro de conexão');
        verifyBtn.disabled = false;
        verifyBtn.textContent = 'Verificar →';
      }
    }

    function toggleMobileMenu() {
      const menu = document.querySelector('.nav-mobile-menu');
      if (menu) menu.classList.toggle('open');
    }
