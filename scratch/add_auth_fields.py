app_jsx_path = 'c:/Users/Chidvilas/PycharmProjects/PythonProject/Automated_Data_Aggregator_Website/frontend/src/App.jsx'

with open(app_jsx_path, 'r', encoding='utf-8') as f:
    content = f.read()

# Normalize line endings to \n
content_norm = content.replace('\r\n', '\n')

# 1. Replace State Declarations
state_target = """  const [authMode, setAuthMode] = useState('login'); // 'login' or 'signup'
  
  const [loginForm, setLoginForm] = useState({ username: '', password: '' });
  const [signupForm, setSignupForm] = useState({ 
    username: '', 
    password: '', 
    districts: ['', '', '', ''] 
  });
  const [authError, setAuthError] = useState('');"""

state_replacement = """  const [authMode, setAuthMode] = useState('login'); // 'login', 'signup', or 'forgot'
  
  const [loginForm, setLoginForm] = useState({ username: '', password: '' });
  const [signupForm, setSignupForm] = useState({ 
    username: '', 
    password: '', 
    phone: '', 
    districts: ['', '', '', ''] 
  });
  const [forgotForm, setForgotForm] = useState({ username: '', phone: '', newPassword: '', confirmPassword: '' });
  const [forgotStep, setForgotStep] = useState(1);
  const [authError, setAuthError] = useState('');
  const [authSuccess, setAuthSuccess] = useState('');"""

if state_target in content_norm:
    content_norm = content_norm.replace(state_target, state_replacement)
    print("State variables replaced successfully.")
else:
    print("Error: State variables target not found!")
    exit(1)


# 2. Replace Auth Handlers
handlers_target = """  const handleSignup = (e) => {
    e.preventDefault();
    setAuthError('');
    
    // Validate that 4 distinct districts are selected
    const selectedDistricts = signupForm.districts.filter(d => d !== '');
    const uniqueDistricts = new Set(selectedDistricts);
    
    if (uniqueDistricts.size !== 4) {
      setAuthError('Please select 4 distinct priority districts.');
      return;
    }
    
    const users = JSON.parse(localStorage.getItem('users') || '{}');
    if (users[signupForm.username]) {
      setAuthError('Username already exists. Please login.');
      return;
    }
    
    // Save new user
    users[signupForm.username] = { 
      password: signupForm.password, 
      districts: signupForm.districts 
    };
    localStorage.setItem('users', JSON.stringify(users));
    
    // Auto-login after signup
    const sessionUser = { username: signupForm.username, districts: signupForm.districts };
    setCurrentUser(sessionUser);
    localStorage.setItem('currentUser', JSON.stringify(sessionUser));
    setActiveTab(0);
  };"""

handlers_replacement = """  const handleSignup = (e) => {
    e.preventDefault();
    setAuthError('');
    
    // Validate 10-digit phone number
    const phoneRegex = /^[0-9]{10}$/;
    if (!phoneRegex.test(signupForm.phone)) {
      setAuthError('Please enter a valid 10-digit phone number.');
      return;
    }
    
    // Validate that 4 distinct districts are selected
    const selectedDistricts = signupForm.districts.filter(d => d !== '');
    const uniqueDistricts = new Set(selectedDistricts);
    
    if (uniqueDistricts.size !== 4) {
      setAuthError('Please select 4 distinct priority districts.');
      return;
    }
    
    const users = JSON.parse(localStorage.getItem('users') || '{}');
    if (users[signupForm.username]) {
      setAuthError('Username already exists. Please login.');
      return;
    }
    
    // Save new user with phone
    users[signupForm.username] = { 
      password: signupForm.password, 
      districts: signupForm.districts,
      phone: signupForm.phone
    };
    localStorage.setItem('users', JSON.stringify(users));
    
    // Auto-login after signup
    const sessionUser = { username: signupForm.username, districts: signupForm.districts };
    setCurrentUser(sessionUser);
    localStorage.setItem('currentUser', JSON.stringify(sessionUser));
    setActiveTab(0);
  };

  const handleForgotVerify = (e) => {
    e.preventDefault();
    setAuthError('');
    setAuthSuccess('');
    const users = JSON.parse(localStorage.getItem('users') || '{}');
    const user = users[forgotForm.username];
    
    if (!user) {
      setAuthError('Username does not exist.');
      return;
    }
    if (user.phone !== forgotForm.phone) {
      setAuthError('Phone number does not match this username.');
      return;
    }
    setForgotStep(2);
  };

  const handleForgotReset = (e) => {
    e.preventDefault();
    setAuthError('');
    if (forgotForm.newPassword !== forgotForm.confirmPassword) {
      setAuthError('Passwords do not match.');
      return;
    }
    
    const users = JSON.parse(localStorage.getItem('users') || '{}');
    const user = users[forgotForm.username];
    if (user) {
      user.password = forgotForm.newPassword;
      localStorage.setItem('users', JSON.stringify(users));
      setAuthSuccess('Password reset successful! Please sign in with your new password.');
      setAuthMode('login');
      setLoginForm({ username: forgotForm.username, password: '' });
      setForgotForm({ username: '', phone: '', newPassword: '', confirmPassword: '' });
      setForgotStep(1);
    } else {
      setAuthError('An error occurred. Username not found.');
    }
  };"""

if handlers_target in content_norm:
    content_norm = content_norm.replace(handlers_target, handlers_replacement)
    print("Auth handlers replaced successfully.")
else:
    print("Error: Auth handlers target not found!")
    exit(1)


# 3. Replace Auth UI Heading description
heading_target = """            <p className="text-slate-400 text-sm mt-1">
              {authMode === 'login' ? 'Sign in to your account' : 'Create a new account'}
            </p>"""

heading_replacement = """            <p className="text-slate-400 text-sm mt-1">
              {authMode === 'login' ? 'Sign in to your account' : authMode === 'signup' ? 'Create a new account' : 'Reset your password'}
            </p>"""

if heading_target in content_norm:
    content_norm = content_norm.replace(heading_target, heading_replacement)
    print("UI heading replaced successfully.")
else:
    print("Error: UI heading target not found!")
    exit(1)


# 4. Replace Error Container to support Success Alert
error_target = """            {authError && (
              <div className="mb-4 p-3 bg-red-50 text-red-600 border border-red-200 rounded-lg text-sm text-center">
                {authError}
              </div>
            )}"""

error_replacement = """            {authError && (
              <div className="mb-4 p-3 bg-red-50 text-red-600 border border-red-200 rounded-lg text-sm text-center">
                {authError}
              </div>
            )}
            {authSuccess && (
              <div className="mb-4 p-3 bg-emerald-50 text-emerald-600 border border-emerald-200 rounded-lg text-sm text-center">
                {authSuccess}
              </div>
            )}"""

if error_target in content_norm:
    content_norm = content_norm.replace(error_target, error_replacement)
    print("Error alerts replaced successfully.")
else:
    print("Error: Error alerts target not found!")
    exit(1)


# 5. Replace Forms Switch
# Target starts at '{authMode === 'login' ? (' and goes down to the end of the signup form closing tag: ')' or '            )}'
# Let's search for the exact block from '{authMode === 'login' ? (' to the closing '            )}' in login rendering section
forms_target = """            {authMode === 'login' ? (
              <form onSubmit={handleLogin} className="space-y-5">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Username</label>
                  <input type="text" required value={loginForm.username} onChange={e => setLoginForm({...loginForm, username: e.target.value})} className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none" placeholder="Enter username" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Password</label>
                  <input type="password" required value={loginForm.password} onChange={e => setLoginForm({...loginForm, password: e.target.value})} className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none" placeholder="••••••••" />
                </div>
                <button type="submit" className="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-2.5 rounded-lg transition-colors">Sign In</button>
                <p className="text-center text-sm text-slate-500 mt-4">
                  Don't have an account? <button type="button" onClick={() => {setAuthMode('signup'); setAuthError('');}} className="text-blue-600 font-medium hover:underline">Sign up</button>
                </p>
              </form>
            ) : (
              <form onSubmit={handleSignup} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Username</label>
                  <input type="text" required value={signupForm.username} onChange={e => setSignupForm({...signupForm, username: e.target.value})} className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none" placeholder="Choose a username" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Password</label>
                  <input type="password" required value={signupForm.password} onChange={e => setSignupForm({...signupForm, password: e.target.value})} className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none" placeholder="Create a password" />
                </div>
                
                <div className="pt-3 border-t border-slate-100">
                  <label className="block text-sm font-bold text-slate-800 mb-2">Select 4 Priority Districts</label>
                  <p className="text-xs text-slate-500 mb-3">Your dashboard will initially filter tenders based on these areas.</p>
                  <div className="grid grid-cols-2 gap-3">
                    {[0, 1, 2, 3].map(index => (
                      <select 
                        key={index} 
                        required 
                        value={signupForm.districts[index]} 
                        onChange={e => handleDistrictChange(index, e.target.value)}
                        className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none bg-slate-50"
                      >
                        <option value="" disabled>District {index + 1}</option>
                        {AP_DISTRICTS.map(district => (
                          <option key={district} value={district}>{district}</option>
                        ))}
                      </select>
                    ))}
                  </div>
                </div>

                <button type="submit" className="w-full bg-slate-900 hover:bg-slate-800 text-white font-bold py-2.5 rounded-lg transition-colors mt-4">Create Account</button>
                <p className="text-center text-sm text-slate-500 mt-4">
                  Already have an account? <button type="button" onClick={() => {setAuthMode('login'); setAuthError('');}} className="text-blue-600 font-medium hover:underline">Sign in</button>
                </p>
              </form>
            )}"""

forms_replacement = """            {authMode === 'login' && (
              <form onSubmit={handleLogin} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Username</label>
                  <input type="text" required value={loginForm.username} onChange={e => setLoginForm({...loginForm, username: e.target.value})} className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none" placeholder="Enter username" />
                </div>
                <div>
                  <div className="flex justify-between items-center mb-1">
                    <label className="block text-sm font-medium text-slate-700">Password</label>
                    <button type="button" onClick={() => { setAuthMode('forgot'); setForgotStep(1); setAuthError(''); setAuthSuccess(''); }} className="text-xs text-blue-600 font-medium hover:underline">Forgot password?</button>
                  </div>
                  <input type="password" required value={loginForm.password} onChange={e => setLoginForm({...loginForm, password: e.target.value})} className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none" placeholder="••••••••" />
                </div>
                <button type="submit" className="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-2.5 rounded-lg transition-colors mt-2">Sign In</button>
                <p className="text-center text-sm text-slate-500 mt-4">
                  Don't have an account? <button type="button" onClick={() => {setAuthMode('signup'); setAuthError(''); setAuthSuccess('');}} className="text-blue-600 font-medium hover:underline">Sign up</button>
                </p>
              </form>
            )}
            {authMode === 'signup' && (
              <form onSubmit={handleSignup} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Username</label>
                  <input type="text" required value={signupForm.username} onChange={e => setSignupForm({...signupForm, username: e.target.value})} className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none" placeholder="Choose a username" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Password</label>
                  <input type="password" required value={signupForm.password} onChange={e => setSignupForm({...signupForm, password: e.target.value})} className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none" placeholder="Create a password" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Phone Number (Linked for password reset)</label>
                  <input type="tel" required value={signupForm.phone || ''} onChange={e => setSignupForm({...signupForm, phone: e.target.value})} className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none" placeholder="10-digit phone number" pattern="[0-9]{10}" title="Please enter a 10-digit phone number" />
                </div>
                
                <div className="pt-3 border-t border-slate-100">
                  <label className="block text-sm font-bold text-slate-800 mb-2">Select 4 Priority Districts</label>
                  <p className="text-xs text-slate-500 mb-3">Your dashboard will initially filter tenders based on these areas.</p>
                  <div className="grid grid-cols-2 gap-3">
                    {[0, 1, 2, 3].map(index => (
                      <select 
                        key={index} 
                        required 
                        value={signupForm.districts[index]} 
                        onChange={e => handleDistrictChange(index, e.target.value)}
                        className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none bg-slate-50"
                      >
                        <option value="" disabled>District {index + 1}</option>
                        {AP_DISTRICTS.map(district => (
                          <option key={district} value={district}>{district}</option>
                        ))}
                      </select>
                    ))}
                  </div>
                </div>

                <button type="submit" className="w-full bg-slate-900 hover:bg-slate-800 text-white font-bold py-2.5 rounded-lg transition-colors mt-4">Create Account</button>
                <p className="text-center text-sm text-slate-500 mt-4">
                  Already have an account? <button type="button" onClick={() => {setAuthMode('login'); setAuthError(''); setAuthSuccess('');}} className="text-blue-600 font-medium hover:underline">Sign in</button>
                </p>
              </form>
            )}
            {authMode === 'forgot' && (
              <form onSubmit={forgotStep === 1 ? handleForgotVerify : handleForgotReset} className="space-y-4">
                {forgotStep === 1 ? (
                  <>
                    <div>
                      <label className="block text-sm font-medium text-slate-700 mb-1">Username</label>
                      <input type="text" required value={forgotForm.username} onChange={e => setForgotForm({...forgotForm, username: e.target.value})} className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none" placeholder="Enter username" />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-slate-700 mb-1">Linked Phone Number</label>
                      <input type="tel" required value={forgotForm.phone} onChange={e => setForgotForm({...forgotForm, phone: e.target.value})} className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none" placeholder="Enter 10-digit phone number" pattern="[0-9]{10}" />
                    </div>
                    <button type="submit" className="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-2.5 rounded-lg transition-colors mt-2">Verify Details</button>
                  </>
                ) : (
                  <>
                    <div className="bg-emerald-50 text-emerald-800 border border-emerald-200 rounded-lg p-3 text-xs mb-2">
                      Details verified! Enter your new password below.
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-slate-700 mb-1">New Password</label>
                      <input type="password" required value={forgotForm.newPassword} onChange={e => setForgotForm({...forgotForm, newPassword: e.target.value})} className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none" placeholder="New password" />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-slate-700 mb-1">Confirm New Password</label>
                      <input type="password" required value={forgotForm.confirmPassword} onChange={e => setForgotForm({...forgotForm, confirmPassword: e.target.value})} className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none" placeholder="Confirm new password" />
                    </div>
                    <button type="submit" className="w-full bg-slate-900 hover:bg-slate-800 text-white font-bold py-2.5 rounded-lg transition-colors mt-2">Reset Password</button>
                  </>
                )}
                <p className="text-center text-sm text-slate-500 mt-4">
                  Back to <button type="button" onClick={() => { setAuthMode('login'); setAuthError(''); setAuthSuccess(''); }} className="text-blue-600 font-medium hover:underline">Sign in</button>
                </p>
              </form>
            )}"""

if forms_target in content_norm:
    content_norm = content_norm.replace(forms_target, forms_replacement)
    print("Forms UI switch replaced successfully.")
else:
    print("Error: Forms UI switch target not found!")
    exit(1)


# Save changes back to App.jsx
with open(app_jsx_path, 'w', encoding='utf-8') as f:
    f.write(content_norm)

print("All modifications completed successfully!")
