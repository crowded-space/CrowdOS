import React, { useState } from 'react';
import { Attachment } from '@/types/crowdOs';
import { File, Eye, Download, FileText, Image as ImageIcon, X } from 'lucide-react';

interface AttachmentsViewProps {
  attachments?: Attachment[];
}

export default function AttachmentsView({ attachments }: AttachmentsViewProps) {
  const [lightboxImage, setLightboxImage] = useState<string | null>(null);

  if (!attachments || attachments.length === 0) return null;

  // Format file size nicely
  const formatSize = (bytes?: number) => {
    if (bytes === undefined) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  // Helper to determine icon for files
  const getFileIcon = (type: string) => {
    if (type.startsWith('image/')) {
      return <ImageIcon size={16} className="text-zinc-400 shrink-0" />;
    }
    if (type.includes('pdf') || type.includes('document') || type.includes('text')) {
      return <FileText size={16} className="text-zinc-400 shrink-0" />;
    }
    return <File size={16} className="text-zinc-400 shrink-0" />;
  };

  return (
    <div className="mt-2.5 space-y-2 select-none" id="message-attachments-root">
      {/* Grid container for attachments */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-w-xl">
        {attachments.map((file) => {
          const isImage = file.type.startsWith('image/');

          if (isImage) {
            return (
              <div 
                key={file.id} 
                className="relative group rounded-lg overflow-hidden border border-zinc-805/90 bg-zinc-950/40 hover:border-zinc-700/80 transition-all duration-200"
                id={`attachment-card-${file.id}`}
              >
                {/* Image element */}
                <div 
                  onClick={() => setLightboxImage(file.url)}
                  className="aspect-video w-full overflow-hidden bg-zinc-900 flex items-center justify-center cursor-zoom-in relative"
                >
                  <img 
                    src={file.url} 
                    alt={file.name}
                    referrerPolicy="no-referrer"
                    className="object-cover w-full h-full group-hover:scale-103 transition-transform duration-300"
                  />
                  <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-2">
                    <button 
                      onClick={(e) => {
                        e.stopPropagation();
                        setLightboxImage(file.url);
                      }}
                      className="p-1.5 bg-zinc-900 border border-zinc-750/80 rounded-full hover:bg-zinc-850 hover:text-white text-zinc-350 hover:border-zinc-600 transition"
                      title="Preview Image"
                    >
                      <Eye size={14} />
                    </button>
                    <a 
                      href={file.url} 
                      download={file.name}
                      onClick={(e) => e.stopPropagation()}
                      className="p-1.5 bg-zinc-900 border border-zinc-750/80 rounded-full hover:bg-zinc-850 hover:text-white text-zinc-350 hover:border-zinc-600 transition"
                      title="Download Image"
                    >
                      <Download size={14} />
                    </a>
                  </div>
                </div>

                {/* Footer labels */}
                <div className="p-2 flex items-center justify-between text-[11px] font-sans border-t border-zinc-900 bg-zinc-950/60">
                  <span className="text-zinc-300 truncate font-semibold" title={file.name}>
                    {file.name}
                  </span>
                  <span className="text-zinc-550 font-mono text-[10px] shrink-0 ml-2">
                    {formatSize(file.size)}
                  </span>
                </div>
              </div>
            );
          }

          // Generic File visual design card
          return (
            <div 
              key={file.id} 
              className="flex items-center justify-between p-2.5 rounded-lg border border-zinc-850/90 bg-zinc-950/40 hover:bg-zinc-950/80 hover:border-zinc-700/80 transition-all duration-200"
              id={`attachment-card-${file.id}`}
            >
              <div className="flex items-center gap-2.5 min-w-0">
                <div className="w-8 h-8 rounded bg-zinc-900/80 border border-zinc-800 flex items-center justify-center text-zinc-400 shrink-0">
                  {getFileIcon(file.type)}
                </div>
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-zinc-200 truncate pr-2 font-sans" title={file.name}>
                    {file.name}
                  </p>
                  <p className="text-[10px] text-zinc-500 font-mono mt-0.5">
                    {formatSize(file.size) || 'Unknown Size'}
                  </p>
                </div>
              </div>

              {/* Action trigger links */}
              <div className="flex items-center gap-1.5 shrink-0 select-none">
                <a 
                  href={file.url} 
                  download={file.name}
                  className="p-1.5 text-zinc-500 hover:text-indigo-400 hover:bg-zinc-900 rounded-md transition focus:outline-none"
                  title="Download File"
                >
                  <Download size={13.5} />
                </a>
              </div>
            </div>
          );
        })}
      </div>

      {/* Lightbox modal zoom element */}
      {lightboxImage && (
        <div 
          onClick={() => setLightboxImage(null)}
          className="fixed inset-0 z-55 bg-black/85 backdrop-blur-xs flex items-center justify-center p-4 cursor-zoom-out animate-fade-in"
          id="lightbox-attachment-overlay"
        >
          <button 
            onClick={() => setLightboxImage(null)}
            className="absolute top-4 right-4 text-zinc-400 hover:text-white p-2 hover:bg-white/10 rounded-full transition focus:outline-none cursor-pointer"
          >
            <X size={20} />
          </button>
          <img 
            src={lightboxImage} 
            alt="Expanded Attachment" 
            referrerPolicy="no-referrer"
            className="max-w-full max-h-[85vh] rounded-lg shadow-2xl object-contain transition-transform duration-305 scale-100"
          />
        </div>
      )}
    </div>
  );
}
