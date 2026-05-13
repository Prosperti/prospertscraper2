import React, { useState, useEffect } from 'react';
import { MapContainer, TileLayer, Circle, Marker, useMapEvents, useMap } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import L from 'leaflet';

// Fix Leaflet default icon issue
delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
});

const defaultCenter = { lat: 51.1657, lng: 10.4515 }; // Center of Germany

interface MapProps {
  onAreaChange: (lat: number, lng: number, radius: number) => void;
  cityCenter?: { lat: number, lng: number } | null;
  radius?: number;
}

function MapEvents({ setCenter, onAreaChange, radius }: any) {
  useMapEvents({
    click(e) {
      setCenter(e.latlng);
      onAreaChange(e.latlng.lat, e.latlng.lng, radius);
    },
  });
  return null;
}

function MapUpdater({ center }: { center: { lat: number, lng: number } }) {
  const map = useMap();
  useEffect(() => {
    map.setView([center.lat, center.lng]);
  }, [center, map]);
  return null;
}

export const MapSelector: React.FC<MapProps> = ({ onAreaChange, cityCenter, radius = 10 }) => {
  const [center, setCenter] = useState(cityCenter || defaultCenter);

  useEffect(() => {
    if (cityCenter) {
      setCenter(prev => {
        if (prev.lat === cityCenter.lat && prev.lng === cityCenter.lng) return prev;
        return cityCenter;
      });
    }
  }, [cityCenter]);

  return (
    <div className="h-[400px] w-full relative z-0">
      <MapContainer 
        center={[center.lat, center.lng]} 
        zoom={6} 
        style={{ height: '100%', width: '100%' }}
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <MapEvents setCenter={setCenter} onAreaChange={onAreaChange} radius={radius} />
        <MapUpdater center={center} />
        
        <Marker 
          position={[center.lat, center.lng]} 
          draggable={true}
          eventHandlers={{
            dragend: (e) => {
              const marker = e.target;
              const position = marker.getLatLng();
              setCenter(position);
              onAreaChange(position.lat, position.lng, radius);
            },
          }}
        />
        <Circle 
          center={[center.lat, center.lng]} 
          radius={radius * 1000} 
          pathOptions={{ color: '#3b82f6', fillColor: '#3b82f6', fillOpacity: 0.2, weight: 2 }}
        />
      </MapContainer>
    </div>
  );
}
