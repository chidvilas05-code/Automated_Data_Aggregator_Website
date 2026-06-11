import React, { useState } from 'react';
import { LayoutDashboard, FileText, Globe, Bell, Search } from 'lucide-react';

const TenderDashboard = () => {
  // Mock data representing what your Selenium script will scrape
  const [tenders] = useState([
    { id: 1, title: "Construction of Smart Classroom", dept: "Education", value: "₹45,00,000", deadline: "2026-05-15" },
    { id: 2, title: "IT Infrastructure Upgrade", dept: "IT & Comm", value: "₹1,20,00,000", deadline: "2026-06-01" },
    { id: 3, title: "Supply of Lab Equipment", dept: "Health", value: "₹12,50,000", deadline: "2026-04-30" },
  ]);

  return (
    <div className="flex min-h-screen bg-slate-50 text-slate-900 font-sans">
      {/* Sidebar */}
      <aside className="w-64 bg-slate-900 text-white p-6 hidden md:block">
        <h1 className="text-xl font-bold mb-10 flex items-center gap-2">
          <Globe className="text-blue-400" /> AP Tender Hub
        </h1>
        <nav className="space-y-4">
          <div className="flex items-center gap-3 p-3 bg-blue-600 rounded-lg cursor-pointer">
            <LayoutDashboard size={20} /> Dashboard
          </div>
          <div className="flex items-center gap-3 p-3 hover:bg-slate-800 rounded-lg cursor-pointer transition-colors text-slate-400">
            <FileText size={20} /> Active Tenders
          </div>
          <div className="flex items-center gap-3 p-3 hover:bg-slate-800 rounded-lg cursor-pointer transition-colors text-slate-400">
            <Bell size={20} /> Notifications
          </div>
        </nav>
      </aside>

      {/* Main Content */}
      <main className="flex-1 p-8">
        {/* Header */}
        <header className="flex justify-between items-center mb-8">
          <div>
            <h2 className="text-2xl font-bold">Tender Overview</h2>
            <p className="text-slate-500">Aggregated from AP eProcurement Portal</p>
          </div>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
            <input 
              type="text" 
              placeholder="Search tenders..." 
              className="pl-10 pr-4 py-2 border border-slate-200 rounded-full bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </header>

        {/* Stats Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
          <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
            <p className="text-slate-500 text-sm uppercase font-semibold">Total Scraped</p>
            <p className="text-3xl font-bold mt-1">124</p>
          </div>
          <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
            <p className="text-slate-500 text-sm uppercase font-semibold">Active Now</p>
            <p className="text-3xl font-bold mt-1 text-green-600">42</p>
          </div>
          <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
            <p className="text-slate-500 text-sm uppercase font-semibold">Expiring Soon</p>
            <p className="text-3xl font-bold mt-1 text-orange-500">8</p>
          </div>
        </div>

        {/* Tender Table */}
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
          <table className="w-full text-left border-collapse">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr>
                <th className="p-4 font-semibold text-slate-600">Tender Title</th>
                <th className="p-4 font-semibold text-slate-600">Department</th>
                <th className="p-4 font-semibold text-slate-600">Estimated Value</th>
                <th className="p-4 font-semibold text-slate-600">Closing Date</th>
                <th className="p-4 font-semibold text-slate-600">Status</th>
              </tr>
            </thead>
            <tbody>
              {tenders.map((tender) => (
                <tr key={tender.id} className="border-b border-slate-100 hover:bg-slate-50 transition-colors">
                  <td className="p-4 font-medium">{tender.title}</td>
                  <td className="p-4 text-slate-600">{tender.dept}</td>
                  <td className="p-4 font-mono">{tender.value}</td>
                  <td className="p-4">{tender.deadline}</td>
                  <td className="p-4">
                    <span className="px-3 py-1 bg-blue-100 text-blue-700 rounded-full text-xs font-bold">Active</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </main>
    </div>
  );
};

export default TenderDashboard;