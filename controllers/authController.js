'use strict';

const userRepository = require('../repositories/userRepository');

function showLogin(req, res) {
  res.render('login', {
    title: 'Sign in',
    error: null,
    username: '',
    layout: false,
  });
}

function login(req, res) {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).render('login', {
      title: 'Sign in',
      error: 'Please enter both username and password.',
      username: username || '',
      layout: false,
    });
  }

  const user = userRepository.verifyCredentials(username.trim(), password);
  if (!user) {
    return res.status(401).render('login', {
      title: 'Sign in',
      error: 'Invalid username or password.',
      username: username.trim(),
      layout: false,
    });
  }

  // Prevent session fixation: regenerate before storing identity.
  req.session.regenerate((err) => {
    if (err) {
      return res.status(500).render('login', {
        title: 'Sign in',
        error: 'Could not start a session. Please try again.',
        username: username.trim(),
        layout: false,
      });
    }
    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.lastActivity = Date.now();
    res.redirect('/');
  });
}

function logout(req, res) {
  req.session.destroy(() => {
    res.clearCookie('sm.sid');
    res.redirect('/login');
  });
}

module.exports = { showLogin, login, logout };
