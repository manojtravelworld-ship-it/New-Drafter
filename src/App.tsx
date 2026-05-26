/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState } from 'react';
import LoginPage from './components/LoginPage';
import AdvocatePortal from './components/AdvocatePortal';

export default function App() {
  const [user, setUser] = useState<any>(null);

  if (!user) {
    return <LoginPage onLogin={(userData) => setUser(userData)} />;
  }

  return <AdvocatePortal onBack={() => setUser(null)} />;
}
