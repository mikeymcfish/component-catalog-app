// Electronic schematic symbol components using SVG files
import resistorIcon from "../assets/icons/resistor.svg";
import capacitorIcon from "../assets/icons/capacitor.svg";
import inductorIcon from "../assets/icons/inductor.svg";
import transistorIcon from "../assets/icons/transistor.svg";
import diodeIcon from "../assets/icons/diode.svg";
import icIcon from "../assets/icons/ic.svg";
import crystalIcon from "../assets/icons/crystal.svg";
import connectorIcon from "../assets/icons/connector.svg";
import switchIcon from "../assets/icons/switch.svg";
import ledIcon from "../assets/icons/led.svg";
import sensorIcon from "../assets/icons/sensor.svg";
import otherIcon from "../assets/icons/other.svg";

interface IconProps {
  className?: string;
  style?: React.CSSProperties;
}

const createSvgIcon = (iconSrc: string) =>
  ({ className = "w-4 h-4", style }: IconProps) => (
    <img
      src={iconSrc}
      alt="component icon"
      className={className}
      style={{ transform: "translateY(12px)", ...style }}
    />
  );

export const ResistorIcon = createSvgIcon(resistorIcon);
export const CapacitorIcon = createSvgIcon(capacitorIcon);
export const InductorIcon = createSvgIcon(inductorIcon);
export const TransistorIcon = createSvgIcon(transistorIcon);
export const DiodeIcon = createSvgIcon(diodeIcon);
export const ICIcon = createSvgIcon(icIcon);
export const CrystalIcon = createSvgIcon(crystalIcon);
export const ConnectorIcon = createSvgIcon(connectorIcon);
export const SwitchIcon = createSvgIcon(switchIcon);
export const LEDIcon = createSvgIcon(ledIcon);
export const SensorIcon = createSvgIcon(sensorIcon);
export const OtherIcon = createSvgIcon(otherIcon);

export const getIconForCategory = (category: string) => {
  const iconMap: Record<string, React.ComponentType<{ className?: string }>> = {
    resistor: ResistorIcon,
    capacitor: CapacitorIcon,
    inductor: InductorIcon,
    transistor: TransistorIcon,
    diode: DiodeIcon,
    ic: ICIcon,
    crystal: CrystalIcon,
    connector: ConnectorIcon,
    switch: SwitchIcon,
    led: LEDIcon,
    sensor: SensorIcon,
    other: OtherIcon,
  };

  return iconMap[category] || OtherIcon;
};
