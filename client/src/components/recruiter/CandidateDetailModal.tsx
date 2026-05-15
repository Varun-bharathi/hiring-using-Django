import { X } from 'lucide-react'
import type { ApplicationListItem } from '@/api/jobs'

interface CandidateDetailModalProps {
  application: ApplicationListItem
  onClose: () => void
}

export function CandidateDetailModal({ application, onClose }: CandidateDetailModalProps) {
  const name = application.job_seeker?.full_name ?? '—'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-2xl max-h-[90vh] overflow-auto rounded-2xl border border-slate-700 bg-slate-900 shadow-xl">
        <div className="sticky top-0 flex items-center justify-between border-b border-slate-800 bg-slate-900 px-6 py-4">
          <h2 className="text-lg font-semibold text-white">Candidate · {name}</h2>
          <button
            onClick={onClose}
            className="p-2 rounded-lg text-slate-400 hover:bg-slate-800 hover:text-white"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-6 space-y-6">
          <div className="grid grid-cols-2 gap-4">

            <div>
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">
                Screening score
              </p>
              <p className="mt-1 text-2xl font-bold text-emerald-400">
                {application.screening_score != null ? `${application.screening_score}%` : '—'}
              </p>
            </div>
            <div>
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">
                Aptitude score
              </p>
              <p className="mt-1 text-2xl font-bold text-brand-400">
                {application.aptitude_score != null ? `${application.aptitude_score}/10` : '—'}
              </p>
            </div>
            <div>
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">
                Coding score
              </p>
              <p className="mt-1 text-2xl font-bold text-purple-400">
                {application.coding_score != null ? `${application.coding_score}/50` : '—'}
              </p>
            </div>
          </div>


        </div>
      </div>
    </div>
  )
}
