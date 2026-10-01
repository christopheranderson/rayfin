import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';

import { useAuth } from '../contexts/AuthContext';
import { ServiceContainer } from '../services/ServiceContainer';
import { initialize } from '../services/initialize';

export const Route = createFileRoute('/initialize')({
  component: RouteComponent,
});

function RouteComponent() {
  const [isInitializing, setIsInitializing] = useState(false);
  const [status, setStatus] = useState<string>('');
  const [signInAsAdmin, setSignInAsAdmin] = useState(true);
  const [addSampleData, setAddSampleData] = useState(true);
  const { user, refreshUser } = useAuth();

  const handleInitialize = async () => {
    setIsInitializing(true);
    setStatus('Initializing...');

    try {
      const serviceContainer = ServiceContainer.getInstance();
      await initialize(serviceContainer, signInAsAdmin, addSampleData);
      await refreshUser();
      const userType = signInAsAdmin ? 'admin' : 'customer';
      const dataMessage = addSampleData
        ? ' with sample data'
        : ' without sample data';
      setStatus(
        `Initialization completed successfully! Signed in as ${userType}${dataMessage}.`
      );
    } catch (error) {
      console.error('Initialization failed:', error);
      setStatus(
        `Initialization failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    } finally {
      setIsInitializing(false);
    }
  };

  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold mb-4">System Initialization</h1>
      <p className="mb-4 text-gray-600">
        Click the button below to initialize the system with sample data and
        users.
      </p>

      <div className="mb-4 space-y-3">
        <label className="flex items-center space-x-2">
          <input
            type="checkbox"
            checked={signInAsAdmin}
            onChange={(e) => setSignInAsAdmin(e.target.checked)}
            disabled={isInitializing}
            className="w-4 h-4 text-blue-600 bg-gray-100 border-gray-300 rounded focus:ring-blue-500 focus:ring-2"
          />
          <span className="text-sm font-medium text-gray-700">
            Sign in as admin user (unchecked = customer)
          </span>
        </label>

        <label className="flex items-center space-x-2">
          <input
            type="checkbox"
            checked={addSampleData}
            onChange={(e) => setAddSampleData(e.target.checked)}
            disabled={isInitializing}
            className="w-4 h-4 text-blue-600 bg-gray-100 border-gray-300 rounded focus:ring-blue-500 focus:ring-2"
          />
          <span className="text-sm font-medium text-gray-700">
            Add sample data (categories and products)
          </span>
        </label>
      </div>

      <button
        onClick={handleInitialize}
        disabled={isInitializing}
        className={`px-4 py-2 rounded font-medium ${
          isInitializing
            ? 'bg-gray-400 cursor-not-allowed'
            : 'bg-blue-600 hover:bg-blue-700'
        } text-white`}
      >
        {isInitializing ? 'Initializing...' : 'Initialize System'}
      </button>

      {status && (
        <div
          className={`mt-4 p-3 rounded ${
            status.includes('failed')
              ? 'bg-red-100 text-red-700'
              : 'bg-green-100 text-green-700'
          }`}
        >
          {status}
        </div>
      )}
    </div>
  );
}
