
import React, { useState, useRef, useCallback, useEffect } from 'react';
import { IdentifiedObjectInfo, BinType } from './types';
import * as geminiService from './services/geminiService';
import ObjectInfoDisplay from './components/ObjectInfoDisplay';
import ActionButton from './components/ActionButton';
import { PROCESSING_INTERVAL_MS, DEFAULT_SIGNAL_IP } from './constants';
import { IconCamera, IconPlay, IconPause, IconStop, IconSpinner } from './components/icons';

const App: React.FC = () => {
  const [videoStream, setVideoStream] = useState<MediaStream | null>(null);
  const [identifiedObject, setIdentifiedObject] = useState<IdentifiedObjectInfo | null>(null);
  const [isProcessingOn, setIsProcessingOn] = useState(false);
  const [isGeminiBusy, setIsGeminiBusy] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const [isCameraInitializing, setIsCameraInitializing] = useState(false);

  const [signalIpAddress, setSignalIpAddress] = useState<string>(DEFAULT_SIGNAL_IP);
  const [signalStatus, setSignalStatus] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const processingTimeoutRef = useRef<number | null>(null);

  const startCamera = useCallback(async () => {
    if (videoStream) return;
    setIsCameraInitializing(true);
    setLastError(null);
    setSignalStatus(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      setVideoStream(stream);
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }
    } catch (err) {
      console.error("Error accessing camera:", err);
      setLastError("Failed to access camera. Please check permissions and ensure no other app is using the camera.");
    } finally {
      setIsCameraInitializing(false);
    }
  }, [videoStream]);

  const stopCamera = useCallback(() => {
    if (videoStream) {
      videoStream.getTracks().forEach(track => track.stop());
    }
    setVideoStream(null);
    setIsProcessingOn(false); 
    setIdentifiedObject(null);
    setSignalStatus(null);
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  }, [videoStream]);

  const sendSignal = async (binType: BinType, rawIpAddress: string) => {
    if (binType === BinType.NotApplicable || binType === BinType.Error || binType === "N/A" as any) { // Added "N/A" check for robustness
      if (binType === BinType.NotApplicable && identifiedObject?.objectName !== "Error") {
         setSignalStatus("No signal sent: Bin type is N/A.");
      }
      return;
    }

    let targetIp = rawIpAddress.trim();
    if (!targetIp) {
      setSignalStatus("Signal IP address is not configured.");
      return;
    }

    if (!targetIp.startsWith('http://') && !targetIp.startsWith('https://')) {
      targetIp = `http://${targetIp}`;
    }

    const category = binType.toLowerCase();
    const url = `${targetIp}/sort?bin=${category}`;
    setSignalStatus(`Sending signal to ${url}...`);

    try {
      // Using 'no-cors' as ESP32 might not send CORS headers.
      // This means we can't read the response, but the request should go through.
      console.log(url);
      await fetch(url, { method: 'GET'});
      setSignalStatus(`Signal successfully dispatched to ${url}. (Note: Response content/status not verified due to no-cors mode)`);
    } catch (error) {
      console.error("Error sending signal:", error);
      let errorMessage = `Failed to send signal to ${targetIp}.`;
      if (error instanceof TypeError && error.message.toLowerCase().includes('failed to fetch')) {
          errorMessage += ` Check network connection, IP address, and ensure the target device is reachable and the server is running.`;
      } else if (error instanceof Error) {
          errorMessage += ` Error: ${error.message}`;
      }
      setSignalStatus(errorMessage);
    }
  };


  const captureAndProcessFrame = useCallback(async () => {
    if (!isProcessingOn || isGeminiBusy || !videoRef.current || !canvasRef.current || !videoRef.current.srcObject || videoRef.current.paused || videoRef.current.ended || videoRef.current.readyState < videoRef.current.HAVE_ENOUGH_DATA) {
      if (isProcessingOn && !isGeminiBusy) { // Reschedule if processing is on but we skipped due to other conditions
        processingTimeoutRef.current = window.setTimeout(captureAndProcessFrame, PROCESSING_INTERVAL_MS);
      }
      return;
    }

    setIsGeminiBusy(true);
    setLastError(null);
    // Do not clear signalStatus here, it might show the result of the previous sendSignal call.

    const video = videoRef.current;
    const canvas = canvasRef.current;

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext('2d');

    if (!context) {
      setLastError('Failed to get canvas context.');
      setIsGeminiBusy(false);
      if (isProcessingOn) processingTimeoutRef.current = window.setTimeout(captureAndProcessFrame, PROCESSING_INTERVAL_MS);
      return;
    }

    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const base64Frame = canvas.toDataURL('image/jpeg', 0.7); // Use JPEG, 0.7 quality for smaller size

    try {
      const result = await geminiService.identifyObjectInFrame(base64Frame);
      setIdentifiedObject(result);

      if (result.objectName === "Error" || result.binType === BinType.Error) { // Check against Enum member
         setLastError(result.reason || "AI processing returned an error.");
         setSignalStatus(`Signal not sent: AI error - ${result.reason}`);
      } else if (result.binType === BinType.NotApplicable || result.objectName === "N/A") {
        setSignalStatus("Signal not sent: Object or bin type is N/A.");
      } else {
        await sendSignal(result.binType, signalIpAddress);
      }
    } catch (error) {
      console.error("Error processing frame:", error);
      const errorMessage = error instanceof Error ? error.message : "An unknown error occurred during processing.";
      setLastError(errorMessage);
      setIdentifiedObject({
        objectName: "Error",
        binType: BinType.NotApplicable,
        reason: errorMessage,
      });
      setSignalStatus(`Signal not sent: Processing error - ${errorMessage}`);
    } finally {
      setIsGeminiBusy(false);
      if (isProcessingOn) { // Only reschedule if processing is still on
        processingTimeoutRef.current = window.setTimeout(captureAndProcessFrame, PROCESSING_INTERVAL_MS);
      }
    }
  }, [isProcessingOn, isGeminiBusy, signalIpAddress]); // Removed videoRef, canvasRef from deps as they are refs

  useEffect(() => {
    if (isProcessingOn && videoStream) {
      if (processingTimeoutRef.current) clearTimeout(processingTimeoutRef.current);
      // Initial call to start the loop
      captureAndProcessFrame(); 
    } else {
      // Clear timeout if processing is turned off or video stream stops
      if (processingTimeoutRef.current) {
        clearTimeout(processingTimeoutRef.current);
        processingTimeoutRef.current = null;
      }
    }
    // Cleanup function to clear timeout when component unmounts or dependencies change
    return () => {
      if (processingTimeoutRef.current) {
        clearTimeout(processingTimeoutRef.current);
      }
    };
  }, [isProcessingOn, videoStream, captureAndProcessFrame]); // captureAndProcessFrame is a dependency

  // Cleanup effect for video stream
  useEffect(() => { 
    return () => {
      if (videoStream) {
        videoStream.getTracks().forEach(track => track.stop());
      }
    };
  }, [videoStream]);

  const toggleProcessing = () => {
    setIsProcessingOn(prev => {
      const newIsProcessingOn = !prev;
      if (!newIsProcessingOn) { 
        // Reset states when stopping processing
        setIdentifiedObject(null); 
        setSignalStatus(null); 
        setLastError(null); // Clear previous errors
      } else {
        // Clear previous status/errors when starting processing
        setSignalStatus(null); 
        setLastError(null);
      }
      return newIsProcessingOn;
    });
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-4 bg-gradient-to-br from-gray-900 via-purple-900 to-blue-900 text-gray-100 selection:bg-purple-500 selection:text-white font-sans">
      <header className="mb-8 text-center">
        <h1 className="text-5xl font-extrabold tracking-tight">
          <span className="bg-clip-text text-transparent bg-gradient-to-r from-green-400 via-blue-500 to-purple-600">
            LitterSplitter
          </span>
        </h1>
        <p className="mt-2 text-lg text-gray-300">Let AI help you sort your waste responsibly!</p>
      </header>

      <div className="w-full max-w-2xl bg-gray-800 shadow-2xl rounded-xl p-6">
        <div className="aspect-video bg-gray-700 rounded-lg overflow-hidden mb-6 border-2 border-gray-600 relative shadow-inner">
          <video ref={videoRef} autoPlay playsInline className="w-full h-full object-cover" muted />
          {isCameraInitializing && (
            <div className="absolute inset-0 flex items-center justify-center bg-black bg-opacity-75 z-10">
              <IconSpinner className="w-12 h-12 text-blue-400" />
              <p className="ml-3 text-lg">Initializing Camera...</p>
            </div>
          )}
           {!videoStream && !isCameraInitializing && (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-gray-700/80 backdrop-blur-sm">
              <IconCamera className="w-24 h-24 text-gray-500 mb-4" />
              <p className="text-gray-400 text-lg">Camera feed will appear here</p>
            </div>
          )}
        </div>
        <canvas ref={canvasRef} className="hidden" aria-hidden="true"></canvas>

        <div className="mb-6">
          <label htmlFor="signalIp" className="block text-sm font-medium text-gray-300 mb-1">
            Signal IP Address (e.g., http://192.168.4.1):
          </label>
          <input
            type="text"
            id="signalIp"
            name="signalIp"
            aria-label="Signal IP Address"
            value={signalIpAddress}
            onChange={(e) => {
              setSignalIpAddress(e.target.value);
              setSignalStatus(null); // Clear signal status when IP changes
            }}
            placeholder={DEFAULT_SIGNAL_IP}
            className="w-full p-2.5 bg-gray-700 border border-gray-600 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-gray-100 placeholder-gray-500 transition-colors duration-150"
            disabled={isProcessingOn}
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
          <ActionButton 
            onClick={startCamera} 
            disabled={isCameraInitializing || !!videoStream} 
            variant="primary"
            aria-label="Start camera"
          >
            {isCameraInitializing ? <IconSpinner className="w-5 h-5"/> : <IconCamera className="w-5 h-5"/>}
            <span>Start Camera</span>
          </ActionButton>
          <ActionButton 
            onClick={toggleProcessing} 
            disabled={!videoStream} 
            variant={isProcessingOn ? "secondary" : "primary"}
            aria-label={isProcessingOn ? "Pause object processing" : "Start object processing"}
          >
            {isGeminiBusy && isProcessingOn ? <IconSpinner className="w-5 h-5"/> : (isProcessingOn ? <IconPause className="w-5 h-5"/> : <IconPlay className="w-5 h-5"/>)}
            <span>{isProcessingOn ? 'Pause Processing' : 'Start Processing'}</span>
          </ActionButton>
          <ActionButton 
            onClick={stopCamera} 
            disabled={!videoStream} 
            variant="danger"
            aria-label="Stop camera and processing"
          >
            <IconStop className="w-5 h-5"/>
            <span>Stop Camera</span>
          </ActionButton>
        </div>

        {lastError && (
          <div role="alert" aria-live="assertive" className="my-4 p-3 bg-red-800 border border-red-600 rounded-md text-red-100 text-sm">
            <strong>Error:</strong> {lastError}
          </div>
        )}
      </div>
      
      <ObjectInfoDisplay info={identifiedObject} isLoading={isGeminiBusy && isProcessingOn} />

      {signalStatus && (
        <div 
          role="status" aria-live="polite"
          className={`mt-4 p-3 rounded-md text-sm max-w-md w-full text-center shadow-md transition-all duration-300 ${
            signalStatus.toLowerCase().includes('failed') || signalStatus.toLowerCase().includes('error') || signalStatus.toLowerCase().includes('not configured') 
            ? 'bg-red-700 text-red-100 border border-red-500' 
            : signalStatus.toLowerCase().includes('sending')
            ? 'bg-blue-700 text-blue-100 border border-blue-500'
            : signalStatus.toLowerCase().includes('n/a')
            ? 'bg-yellow-700 text-yellow-100 border border-yellow-500'
            : 'bg-green-700 text-green-100 border border-green-500'
          }`}
        >
          {signalStatus}
        </div>
      )}

      <footer className="mt-12 text-center text-gray-500 text-sm">
        <p>&copy; {new Date().getFullYear()} LitterSplitter. Powered by Gemini.</p>
        <p>For educational and demonstration purposes only.</p>
      </footer>
    </div>
  );
};

export default App;
