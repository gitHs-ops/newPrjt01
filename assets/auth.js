/* newPrjt01 — 인증 공통 로직 (데모용)
 *
 * ⚠ 저장소는 localStorage 다. 테스트 목적이라 사용자가 명시적으로 허가한 방식이며,
 *    실제 서비스에서는 서버 인증으로 교체해야 한다.
 *
 * 다만 비밀번호는 **평문으로 저장하지 않는다.** PBKDF2-SHA256(100k) + 사용자별 랜덤 솔트로
 * 해시해서 보관한다. localStorage 를 쓰더라도 비밀번호 평문 저장은 피할 수 있고,
 * 피해야 한다.
 */

(function (global) {
  'use strict';

  var USERS_KEY = 'np_users';
  var SESSION_KEY = 'np_session';
  var PBKDF2_ITER = 100000;

  /* ---------- 유틸 ---------- */

  function bufToB64(buf) {
    var bytes = new Uint8Array(buf), s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }

  function b64ToBuf(b64) {
    var s = atob(b64), bytes = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
    return bytes;
  }

  /** Web Crypto 는 보안 컨텍스트(https 또는 http://localhost)에서만 제공된다.
   *  file:// 로 직접 열면 없으므로 반드시 로컬 서버로 띄워야 한다. */
  function cryptoAvailable() {
    return !!(global.crypto && global.crypto.subtle && global.isSecureContext);
  }

  function requireCrypto() {
    if (!cryptoAvailable()) {
      throw new Error(
        '이 페이지는 file:// 로 직접 열면 동작하지 않습니다. ' +
        'init.ps1(또는 init.sh)로 로컬 서버를 띄운 뒤 http://localhost:8940/ 로 접속하세요.'
      );
    }
  }

  /* ---------- 비밀번호 해시 ---------- */

  function deriveHash(password, saltBytes) {
    var enc = new TextEncoder();
    return global.crypto.subtle
      .importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits'])
      .then(function (key) {
        return global.crypto.subtle.deriveBits(
          { name: 'PBKDF2', salt: saltBytes, iterations: PBKDF2_ITER, hash: 'SHA-256' },
          key,
          256
        );
      })
      .then(bufToB64);
  }

  function hashPassword(password) {
    requireCrypto();
    var salt = global.crypto.getRandomValues(new Uint8Array(16));
    return deriveHash(password, salt).then(function (hash) {
      return { salt: bufToB64(salt), hash: hash };
    });
  }

  function verifyPassword(password, saltB64, expectedHash) {
    requireCrypto();
    return deriveHash(password, b64ToBuf(saltB64)).then(function (hash) {
      // 길이가 같을 때만 상수시간 비교
      if (hash.length !== expectedHash.length) return false;
      var diff = 0;
      for (var i = 0; i < hash.length; i++) diff |= hash.charCodeAt(i) ^ expectedHash.charCodeAt(i);
      return diff === 0;
    });
  }

  /* ---------- 사용자 저장소 ---------- */

  function getUsers() {
    try {
      var raw = localStorage.getItem(USERS_KEY);
      var parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];
    }
  }

  function saveUsers(users) {
    localStorage.setItem(USERS_KEY, JSON.stringify(users));
  }

  function findUser(id) {
    var key = String(id || '').trim().toLowerCase();
    var users = getUsers();
    for (var i = 0; i < users.length; i++) {
      if (String(users[i].id).toLowerCase() === key) return users[i];
    }
    return null;
  }

  function isIdTaken(id) {
    return findUser(id) !== null;
  }

  /* ---------- 아이디/비밀번호 규칙 ---------- */

  function validateId(id) {
    var v = String(id || '').trim();
    if (!v) return '아이디를 입력하세요.';
    if (v.length < 4 || v.length > 20) return '아이디는 4~20자여야 합니다.';
    if (!/^[a-zA-Z0-9_]+$/.test(v)) return '영문·숫자·밑줄(_)만 쓸 수 있습니다.';
    return null;
  }

  function validatePassword(pw) {
    var v = String(pw || '');
    if (!v) return '비밀번호를 입력하세요.';
    if (v.length < 8) return '비밀번호는 8자 이상이어야 합니다.';
    if (!/[a-zA-Z]/.test(v) || !/[0-9]/.test(v)) return '영문과 숫자를 모두 포함해야 합니다.';
    return null;
  }

  /* ---------- 가입 / 로그인 ---------- */

  function signup(id, password) {
    return Promise.resolve().then(function () {
      var idErr = validateId(id);
      if (idErr) throw new Error(idErr);
      var pwErr = validatePassword(password);
      if (pwErr) throw new Error(pwErr);
      if (isIdTaken(id)) throw new Error('이미 사용 중인 아이디입니다.');

      return hashPassword(password).then(function (cred) {
        var users = getUsers();
        users.push({
          id: String(id).trim(),
          salt: cred.salt,
          hash: cred.hash,
          provider: 'local',
          createdAt: new Date().toISOString()
        });
        saveUsers(users);
        return { id: String(id).trim() };
      });
    });
  }

  function login(id, password, remember) {
    return Promise.resolve().then(function () {
      if (!String(id || '').trim()) throw new Error('아이디를 입력하세요.');
      if (!String(password || '')) throw new Error('비밀번호를 입력하세요.');

      var user = findUser(id);
      // 아이디가 없어도 같은 메시지를 준다 — 존재 여부를 흘리지 않기 위해
      if (!user) throw new Error('아이디 또는 비밀번호가 일치하지 않습니다.');
      if (user.provider === 'google') {
        throw new Error('이 아이디는 Google 계정으로 가입되어 있습니다. Google 로그인을 이용하세요.');
      }

      return verifyPassword(password, user.salt, user.hash).then(function (ok) {
        if (!ok) throw new Error('아이디 또는 비밀번호가 일치하지 않습니다.');
        setSession({ id: user.id, provider: 'local' }, remember);
        return { id: user.id };
      });
    });
  }

  /** 데모용 Google 로그인.
   *  실제 OAuth 가 아니다 — 실제 연동은 Google Cloud 클라이언트 ID 발급과
   *  서버측 토큰 검증이 필요하다. 여기서는 흐름만 재현한다. */
  function googleLoginDemo(remember) {
    return Promise.resolve().then(function () {
      var demoId = 'google_demo_user';
      if (!findUser(demoId)) {
        var users = getUsers();
        users.push({
          id: demoId,
          salt: null,
          hash: null,
          provider: 'google',
          createdAt: new Date().toISOString()
        });
        saveUsers(users);
      }
      setSession({ id: demoId, provider: 'google' }, remember);
      return { id: demoId, provider: 'google' };
    });
  }

  /** 비밀번호 재설정(데모).
   *  해시로 저장하므로 원래 비밀번호를 되찾는 것은 불가능하다 — 재설정만 가능하다.
   *  실제 서비스라면 이메일/문자 본인확인이 선행되어야 한다. */
  function resetPassword(id, newPassword) {
    return Promise.resolve().then(function () {
      var user = findUser(id);
      if (!user) throw new Error('등록되지 않은 아이디입니다.');
      if (user.provider === 'google') throw new Error('Google 계정은 비밀번호를 재설정할 수 없습니다.');
      var pwErr = validatePassword(newPassword);
      if (pwErr) throw new Error(pwErr);

      return hashPassword(newPassword).then(function (cred) {
        var users = getUsers();
        for (var i = 0; i < users.length; i++) {
          if (String(users[i].id).toLowerCase() === String(id).trim().toLowerCase()) {
            users[i].salt = cred.salt;
            users[i].hash = cred.hash;
            users[i].updatedAt = new Date().toISOString();
          }
        }
        saveUsers(users);
        return { id: user.id };
      });
    });
  }

  /* ---------- 세션 ---------- */

  /** remember=true 면 localStorage(브라우저 재시작 후에도 유지),
   *  아니면 sessionStorage(탭 닫으면 소멸). "로그인 상태 유지" 체크박스가 이걸 고른다. */
  function setSession(data, remember) {
    var payload = JSON.stringify({
      id: data.id,
      provider: data.provider || 'local',
      remember: !!remember,
      loginAt: new Date().toISOString()
    });
    clearSession();
    (remember ? localStorage : sessionStorage).setItem(SESSION_KEY, payload);
  }

  function getSession() {
    try {
      var raw = localStorage.getItem(SESSION_KEY) || sessionStorage.getItem(SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function clearSession() {
    localStorage.removeItem(SESSION_KEY);
    sessionStorage.removeItem(SESSION_KEY);
  }

  /** 보호된 페이지에서 호출 — 세션 없으면 로그인 화면으로 보낸다.
   *  ⚠ 클라이언트 가드일 뿐 보안 경계가 아니다(데모). */
  function requireAuth(redirectTo) {
    var s = getSession();
    if (!s) {
      location.replace(redirectTo || 'login.html');
      return null;
    }
    return s;
  }

  /* ---------- 공개 API ---------- */

  global.Auth = {
    cryptoAvailable: cryptoAvailable,
    validateId: validateId,
    validatePassword: validatePassword,
    isIdTaken: isIdTaken,
    getUsers: getUsers,
    signup: signup,
    login: login,
    googleLoginDemo: googleLoginDemo,
    resetPassword: resetPassword,
    getSession: getSession,
    clearSession: clearSession,
    requireAuth: requireAuth
  };
})(window);
