import { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Badge } from "@/components/ui/badge";
import { Client } from "@/types/logistics";
import { format, addDays, isSameDay } from "date-fns";
import { fr } from "date-fns/locale";
import { Loader2, Zap, CheckCircle2, Truck, BarChart3 } from "lucide-react";
import { toast } from "sonner";
import { LocalSolverService } from "@/services/localSolver";
import { getClientCommandoZone, getCommandoDayForDept, COMMANDO_ZONES } from "@/lib/regions";
import { getClientDeliveryDate, getRegionFromDept, parseClientDate } from "@/lib/business-logic";
import { isZoneMatch } from "@/lib/utils";
import { LOGISTICS_CONFIG } from "@/config/logistics";

const ZONE_DEPOTS: Record<string, { lat: number, lon: number, id: string }> = {
    'FR': { lat: 48.8566, lon: 2.3522, id: 'DEPOT_PARIS' },
    'GP': { lat: 16.24125, lon: -61.53614, id: 'DEPOT_PAP' },
    'MQ': { lat: 14.61606, lon: -61.05878, id: 'DEPOT_FDF' },
    'CORSE': { lat: 41.9192, lon: 8.7386, id: 'DEPOT_AJA' },
};

const getDepotForClient = (client: any) => {
    const cp = client.codePostal || client.code_postal || '75000';
    let region = 'FR';

    if (cp.startsWith('97')) {
        const fullRegion = getRegionFromDept(cp.substring(0, 3));
        if (['GP', 'MQ'].includes(fullRegion)) region = fullRegion;
    } else {
        const dept = cp.substring(0, 2);
        const fullRegion = getRegionFromDept(dept);
        if (fullRegion === 'CORSE') region = 'CORSE';
    }

    return ZONE_DEPOTS[region] || ZONE_DEPOTS['FR'];
};

const getLat = (c: any) => {
    if (c.gps?.lat) return c.gps.lat;
    if (c.latitude) return parseFloat(c.latitude);
    return 48.85; // Paris default
};

const getLon = (c: any) => {
    if (c.gps?.lon) return c.gps.lon;
    if (c.longitude) return parseFloat(c.longitude);
    return 2.35; // Paris default
};

interface QuickPlanningModalProps {
    client: Client | null;
    allClients?: Client[];
    isOpen: boolean;
    onClose: () => void;
    onConfirm: (data: { date: Date; camionId: string }) => void;
}

interface SmartSuggestion {
    date: Date;
    label: string;
    reason: string;
    status: 'OPTIMAL' | 'GOOD' | 'OK' | 'IMPOSSIBLE';
    existingClients: number;
    returnTime?: string;
    region?: string; // Emoji
    regionName?: string;
}

const ZONE_COLORS: Record<number, string> = {
    1: "bg-blue-200 text-blue-800 border-blue-400 hover:bg-blue-300",
    2: "bg-cyan-200 text-cyan-800 border-cyan-400 hover:bg-cyan-300",
    3: "bg-yellow-200 text-yellow-800 border-yellow-400 hover:bg-yellow-300",
    4: "bg-orange-200 text-orange-800 border-orange-400 hover:bg-orange-300",
    5: "bg-red-200 text-red-800 border-red-400 hover:bg-red-300",
    6: "bg-indigo-200 text-indigo-800 border-indigo-400 hover:bg-indigo-300",
    7: "bg-emerald-200 text-emerald-800 border-emerald-400 hover:bg-emerald-300"
};

export function QuickPlanningModal({ client, allClients, isOpen, onClose, onConfirm }: QuickPlanningModalProps) {
    const [selectedDate, setSelectedDate] = useState<Date | undefined>();
    const [suggestions, setSuggestions] = useState<SmartSuggestion[]>([]);
    const [confirming, setConfirming] = useState(false);
    const [optimizedDays, setOptimizedDays] = useState<any[]>([]);
    const [totalStats, setTotalStats] = useState({ distance: 0, duration: 0 });
    const [calendarZoneMap, setCalendarZoneMap] = useState<Record<string, number>>({});
    const [blockedDates, setBlockedDates] = useState<Map<string, string>>(new Map());

    // Fonction pour calculer la date de fin estimée d'une installation
    const calculateEstimatedEnd = (startDate: Date, nbLed: number): Date => {
        const ledsPerDay = 60;
        const startHour = 9;
        const endHour = 18;
        const workingHoursPerDay = endHour - startHour;
        const ledsPerHour = ledsPerDay / workingHoursPerDay;

        let currentDate = new Date(startDate);
        let remainingLed = nbLed || 0;

        console.log(`🔧 [Calcul] Début: ${currentDate.toISOString()}, LEDs: ${nbLed}`);

        if (remainingLed <= 0) {
            console.log(`⚠️ [Calcul] Aucune LED à installer, retour immédiat`);
            return currentDate;
        }

        // Ajuster à l'heure de début
        if (currentDate.getHours() < startHour) {
            currentDate.setHours(startHour, 0, 0, 0);
        } else if (currentDate.getHours() >= endHour) {
            currentDate.setDate(currentDate.getDate() + 1);
            currentDate.setHours(startHour, 0, 0, 0);
        }

        // Sauter les weekends
        while (currentDate.getDay() === 0 || currentDate.getDay() === 6) {
            currentDate.setDate(currentDate.getDate() + 1);
            currentDate.setHours(startHour, 0, 0, 0);
        }

        let iterations = 0;
        const MAX_ITERATIONS = 100; // Sécurité : max 100 jours

        while (remainingLed > 0.1 && iterations < MAX_ITERATIONS) {
            iterations++;

            // Sauter weekends
            if (currentDate.getDay() === 0 || currentDate.getDay() === 6) {
                currentDate.setDate(currentDate.getDate() + 1);
                currentDate.setHours(startHour, 0, 0, 0);
                continue;
            }

            const currentHour = currentDate.getHours() + (currentDate.getMinutes() / 60);
            const hoursLeftToday = Math.max(0, endHour - currentHour);
            const ledsPossibleToday = hoursLeftToday * ledsPerHour;

            if (ledsPossibleToday >= remainingLed) {
                const hoursNeeded = remainingLed / ledsPerHour;
                const totalMinutesNeeded = hoursNeeded * 60;
                currentDate.setMinutes(currentDate.getMinutes() + totalMinutesNeeded);
                remainingLed = 0;
            } else {
                remainingLed -= ledsPossibleToday;
                currentDate.setDate(currentDate.getDate() + 1);
                currentDate.setHours(startHour, 0, 0, 0);
            }
        }

        if (iterations >= MAX_ITERATIONS) {
            console.error(`❌ [Calcul] ERREUR: Boucle infinie détectée! Arrêt forcé après ${MAX_ITERATIONS} itérations`);
        }

        console.log(`✅ [Calcul] Fin: ${currentDate.toISOString()}, Itérations: ${iterations}`);
        return currentDate;
    };

    // 0. Helper pour vérifier la disponibilité
    const checkInstallAvailability = (startDate: Date, nbLed: number): { valid: boolean; reason?: string } => {
        const dateStr = format(startDate, 'yyyy-MM-dd');
        const day = startDate.getDay();
        const isWeekend = day === 0 || day === 6;

        // Check basic blocking first
        if (blockedDates.has(dateStr)) return { valid: false, reason: '🔒 Date occupée' };
        if (isWeekend) return { valid: false, reason: 'Week-end' };

        // Vérification durée complète
        const dailyCapacity = 55;
        const daysNeeded = nbLed > 0 ? Math.ceil(nbLed / dailyCapacity) : 1;

        let currentCheck = new Date(startDate);
        let workedDays = 0;
        let loops = 0;

        while (workedDays < daysNeeded && loops < 30) {
            loops++;
            const currentStr = format(currentCheck, 'yyyy-MM-dd');
            const d = currentCheck.getDay();
            const isWE = d === 0 || d === 6;

            if (blockedDates.has(currentStr)) {
                return { valid: false, reason: `⛔ Conflit le ${format(currentCheck, 'dd/MM')}` };
            }

            if (!isWE) workedDays++;
            currentCheck.setDate(currentCheck.getDate() + 1);
        }
        return { valid: true };
    };

    // 0. Calculer les dates bloquées par les installations en cours
    useEffect(() => {
        if (!allClients || !isOpen || !client) return;

        const blocked = new Map<string, string>();
        const clientZone = client.zone_pays || 'FR';

        // console.log(`🔍 [Blocage] Analyse des conflits pour la zone: ${clientZone}`);

        allClients.forEach(c => {
            // RÈGLE 0: Ne pas se bloquer soi-même !
            const cId = (c as any).id || (c as any)._id;
            const clientId = (client as any).id || (client as any)._id;
            // FIX: Comparison string vs number safe
            if (cId && clientId && String(cId) === String(clientId)) return;

            const cName = `${(c as any).prenom} ${(c as any).nom}`;
            const myName = `${client.prenom} ${client.nom}`;


            // RÈGLE 1: Ne bloquer que les clients de la MÊME ZONE
            const cZone = (c as any).zone_pays || 'FR';
            if (!isZoneMatch(cZone, clientZone)) return;

            // RÈGLE 2: Vérifier si le client a une installation ou une livraison planifiée
            let startDate: Date | null = null;
            let nbLed = (c as any).nb_led || (c as any).nombreLED || 0;

            const installStatus = (c as any).statut_installation || '';
            const globalStatus = (c as any).statut_client || (c as any).statut || '';
            const statusUpper = (installStatus + ' ' + globalStatus).toUpperCase();

            // STRICTE : On ne bloque que ce qui est VRAIMENT "EN COURS" OU "PLANIFIÉ" / "CONFIRMÉ"
            // On exclut "A PLANIFIER", "NON PLANIFIÉ", "A RAPPELER", "ANNULÉ"
            const isActive = (
                (statusUpper.includes('PLANIFI') || statusUpper.includes('CONFIRM') || statusUpper.includes('EN COURS') || statusUpper.includes('EN_COURS')) &&
                !statusUpper.includes('NON') &&
                !statusUpper.includes('A PLANIFI') &&
                !statusUpper.includes('À PLANIFI') &&
                !statusUpper.includes('ANNUL')
            );

            const installStart = (c as any).date_install_debut || (c as any).dateDebutTravaux;
            const deliveryDate = (c as any).date_livraison_prevue || (c as any).date_livraison;

            // On prend la date d'install si elle existe, sinon la date de livraison prévue
            const startRaw = installStart || deliveryDate;

            if (isActive && startRaw) {
                // Use robust parser for "DD/MM/YYYY" or "YYYY-MM-DD"
                const parsed = parseClientDate(startRaw);
                if (parsed) {
                    startDate = parsed;
                }
            }

            if (!startDate || nbLed <= 0) return;

            // Check if start date is valid and reasonable (not year 1970)
            if (isNaN(startDate.getTime()) || startDate.getFullYear() < 2024) {
                // Try brute force french format dd/mm/yyyy
                const parts = String(startRaw).split('/');
                if (parts.length === 3) {
                    startDate = new Date(parseInt(parts[2]), parseInt(parts[1]) - 1, parseInt(parts[0]));
                }
                if (!startDate || isNaN(startDate.getTime())) return;
            }

            startDate.setHours(0, 0, 0, 0);

            let endDate: Date;
            const explicitEnd = (c as any).date_install_fin_reelle || (c as any).dateFinTravaux;

            if (explicitEnd) {
                endDate = new Date(explicitEnd);
            } else {
                endDate = calculateEstimatedEnd(startDate, nbLed);
            }

            const endDateDay = new Date(endDate);
            endDateDay.setHours(0, 0, 0, 0);

            // Bloquer toutes les dates (SAUF WEEKEND)
            const current = new Date(startDate);
            // Safety cap: don't loop more than 60 days
            let safety = 0;
            while (current <= endDateDay && safety < 60) {
                safety++;
                const day = current.getDay();
                if (day !== 0 && day !== 6) {
                    const dKey = format(current, 'yyyy-MM-dd');
                    if (!blocked.has(dKey)) {
                        blocked.set(dKey, cName);
                    }
                }
                current.setDate(current.getDate() + 1);
            }
        });

        console.log(`🔒 TOTAL: ${blocked.size} ours ouvrés bloqués par des chantiers.`);
        setBlockedDates(blocked);
    }, [allClients, isOpen, client]);

    // 1. Calculer la map des zones globalement (pour le calendrier)
    useEffect(() => {
        if (!allClients) return;
        const map: Record<string, number> = {};
        const ZoneCounts: Record<string, Record<number, number>> = {};

        allClients.forEach(c => {
            if (client && !isZoneMatch(c.zone_pays, client.zone_pays || 'FR')) return; // Filter by zone

            const d = getClientDeliveryDate(c);
            if (!d) return;
            const dateStr = format(d, 'yyyy-MM-dd');

            // Count all clients in zone, even if they don't have a specific "Commando" zone (e.g. DOM/TOM)
            const zone = getClientCommandoZone(c);
            const zoneIdx = zone ? zone.dayIndex : 1; // Fallback to 1 (Monday/Blue) for generic busy days

            if (!ZoneCounts[dateStr]) ZoneCounts[dateStr] = {};
            ZoneCounts[dateStr][zoneIdx] = (ZoneCounts[dateStr][zoneIdx] || 0) + 1;
        });

        Object.keys(ZoneCounts).forEach(date => {
            let max = 0;
            let dominant = 0;
            Object.entries(ZoneCounts[date]).forEach(([zoneIdx, count]) => {
                if (count > max) {
                    max = count;
                    dominant = parseInt(zoneIdx);
                }
            });
            if (dominant > 0) map[date] = dominant;
        });
        setCalendarZoneMap(map);
    }, [allClients, client]);

    // 2. Générer les suggestions
    useEffect(() => {
        if (!isOpen || !client || !allClients) return;

        const generateSuggestions = async () => {
            const smartSuggestions: SmartSuggestion[] = [];
            const today = new Date();
            today.setHours(0, 0, 0, 0);

            const clientLat = getLat(client);
            const clientLon = getLon(client);

            for (let i = 1; i <= 30; i++) {
                const checkDate = addDays(today, i);
                const dateStr = format(checkDate, 'yyyy-MM-dd');

                const dayClients = allClients.filter(c => {
                    const d = getClientDeliveryDate(c);
                    // Filter: Must be same day AND same zone/region
                    const isSameZone = isZoneMatch(c.zone_pays, client.zone_pays || 'FR');
                    return d && format(d, 'yyyy-MM-dd') === dateStr && isSameZone;
                });

                const commandoZone = getClientCommandoZone(client);
                let dayOfWeek = checkDate.getDay();
                if (dayOfWeek === 0) dayOfWeek = 7;

                let status: SmartSuggestion['status'] = 'OK';
                let reason = '';

                // VÉRIFICATION DE CHEVAUCHEMENT ROBUSTE
                // On calcule le nombre de jours de TRAVAIL nécessaires (hors weekends)
                // Hypothèse prudente : 55 LEDs / jour (installateur fait 50-70)
                const clientNbLed = (client as any).nb_led || (client as any).nombreLED || 0;
                const dailyCapacity = 55;
                // Minimum 1 jour si > 0 LEDs
                const daysNeeded = clientNbLed > 0 ? Math.ceil(clientNbLed / dailyCapacity) : 1;

                let hasConflict = false;
                let conflictDateStr = '';

                let currentCheck = new Date(checkDate);

                // On vérifie CHAQUE JOUR de travail nécessaire
                let workedDays = 0;
                // Sécurité boucle : max 30 jours
                while (workedDays < daysNeeded && workedDays < 30) {
                    const currentStr = format(currentCheck, 'yyyy-MM-dd');
                    const day = currentCheck.getDay();
                    const isWeekend = day === 0 || day === 6;

                    // 1. Est-ce que ce jour est déjà pris par un autre chantier ?
                    // (On vérifie même les weekends au cas où un chantier déborderait dessus, bien que bloqué visuellement)
                    if (blockedDates.has(currentStr)) {
                        hasConflict = true;
                        conflictDateStr = currentStr;
                        break;
                    }

                    // 2. Si c'est un jour ouvré, on avance le compteur de travail
                    if (!isWeekend) {
                        workedDays++;
                    }

                    // 3. Passer au jour suivant
                    currentCheck.setDate(currentCheck.getDate() + 1);
                }

                // Log pour comprendre pourquoi une date est refusée ou acceptée
                // if (clientNbLed > 100) { // Log seulement pour les gros chantiers
                //      console.log(`🧐 Test ${dateStr} pour ${clientNbLed} LEDs. Fin estimée: ${format(newInstallEndDay, 'yyyy-MM-dd')}. Conflit? ${hasConflict ? `OUI (${conflictDateStr})` : 'NON'}`);
                // }

                // Vérifier si la date est bloquée par une installation
                if (hasConflict) {
                    status = 'IMPOSSIBLE';
                    const blocker = blockedDates.get(conflictDateStr) || 'Autre chantier';
                    reason = `⛔ ${blocker}`; // Display WHO blocks it
                } else if (dayOfWeek === 6 || dayOfWeek === 7) {
                    status = 'IMPOSSIBLE';
                    reason = 'Week-end';
                } else if (commandoZone && dayOfWeek === commandoZone.dayIndex) {
                    status = 'OPTIMAL';
                    reason = `Zone ${commandoZone.name}`;
                } else {
                    // Calcul distance si pas le bon jour commando
                    let minDistance = Infinity;
                    dayClients.forEach(dc => {
                        const d = calculateDistance(clientLat, clientLon, getLat(dc), getLon(dc));
                        if (d < minDistance) minDistance = d;
                    });
                    if (minDistance < 100) {
                        status = 'GOOD';
                        reason = `Proximité (${Math.round(minDistance)}km)`;
                    } else {
                        reason = 'Ouverture possible';
                    }
                }

                smartSuggestions.push({
                    date: checkDate,
                    label: format(checkDate, 'EEEE d MMM', { locale: fr }),
                    reason,
                    status,
                    existingClients: dayClients.length,
                    region: commandoZone?.emoji || "📍"
                });
            }

            smartSuggestions.sort((a, b) => {
                const order = { OPTIMAL: 0, GOOD: 1, OK: 2, IMPOSSIBLE: 3 };
                return order[a.status] - order[b.status];
            });

            // MODIF: On montre TOUTES les suggestions, même "IMPOSSIBLE", pour laisser le choix
            const validSuggestions = smartSuggestions; // .filter(s => s.status !== 'IMPOSSIBLE');

            setSuggestions(validSuggestions);

            // Respect existing date if present
            const existingDate = getClientDeliveryDate(client);
            if (existingDate && !isNaN(existingDate.getTime())) {
                setSelectedDate(existingDate);
            } else if (validSuggestions.length > 0) {
                setSelectedDate(validSuggestions[0].date);
            }
        };

        generateSuggestions();
    }, [isOpen, client, allClients, blockedDates]);

    // 3. Simuler la journée sélectionnée
    useEffect(() => {
        if (!selectedDate || !client || !allClients) return;

        const simulate = async () => {
            try {
                const dateStr = format(selectedDate, 'yyyy-MM-dd');
                const dayClients = allClients.filter(c => {
                    const d = getClientDeliveryDate(c);
                    const isSameZone = isZoneMatch(c.zone_pays, client.zone_pays || 'FR');
                    return d && format(d, 'yyyy-MM-dd') === dateStr && isSameZone;
                });

                // Enrichir les clients avec lat/lon garantis par les helpers du modal
                const tripClientsRaw = [...dayClients.filter(c => String(c.id) !== String(client.id)), client]; // Force string comparison
                const tripClients = tripClientsRaw.map(c => ({
                    ...c,
                    lat: getLat(c),
                    lon: getLon(c)
                }));
                const startPoint = getDepotForClient(client);

                // UTILISATION DU CLOUD (VROOM / ORS)
                // Note : solveCloud est async et appelle l'API backend
                const result = await LocalSolverService.solveCloud(tripClients, startPoint, selectedDate);

                setOptimizedDays(result.days || []);
                setTotalStats({
                    distance: result.totalDistanceKm,
                    duration: result.totalDurationMinutes
                });
            } catch (err) {
                console.error("Simulation Crashed:", err);
                toast.error("Erreur de calcul de l'itinéraire.");
            }
        };

        simulate();
    }, [selectedDate, client, allClients]);

    const calculateDistance = (lat1: number, lon1: number, lat2: number, lon2: number) => {
        const R = 6371;
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLon = (lon2 - lon1) * Math.PI / 180;
        const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    };

    const handleQuickConfirm = async () => {
        if (!selectedDate || !client) return;
        setConfirming(true);
        try {
            await onConfirm({ date: selectedDate, camionId: `camion-standard-${LOGISTICS_CONFIG.TRUCK_CAPACITY}` });
            toast.success("Planifié avec succès !");
            onClose();
        } catch (e) {
            toast.error("Erreur de planification");
        } finally {
            setConfirming(false);
        }
    };

    const handleDateSelect = (date: Date | undefined) => {
        if (!date || !client) return;

        // 1. Calculer la durée du chantier
        const estimatedEnd = calculateEstimatedEnd(date, client.nb_led || 0);

        // 2. Vérifier les conflits sur toute la durée
        let current = new Date(date);
        const end = new Date(estimatedEnd);
        let conflictFound = false;
        let conflictReason = "";

        // Sécurité boucle
        let loops = 0;
        while (current <= end && loops < 100) {
            const dateStr = format(current, 'yyyy-MM-dd');

            // Ignorer les weekends (ils ne sont pas travaillés, donc pas de conflit d'agenda possible si on ne travaille pas)
            // Mais attention: si un chantier de 5 jours commence Jeudi, il finit Mercredi suivant.
            // Les Samedi/Dimanche au milieu ne comptent pas comme "conflit" car on ne travaille pas.
            // PAR CONTRE: Si 'blockedDates' contient un Samedi (ex: installation exceptionnelle), c'est un conflit.

            if (blockedDates.has(dateStr)) {
                conflictFound = true;
                const blockerName = blockedDates.get(dateStr);
                conflictReason = `Conflit le ${format(current, 'dd/MM')} avec ${blockerName}`;
                break;
            }

            // Jour suivant
            current.setDate(current.getDate() + 1);
            loops++;
        }

        if (conflictFound) {
            toast.error("Impossible de planifier ici", {
                description: `Ce chantier de ${loops} jours chevauche une autre installation.\n${conflictReason}`
            });
            return; // Bloque la sélection
        }

        setSelectedDate(date);
    };

    if (!client) return null;

    return (
        <Dialog open={isOpen} onOpenChange={onClose}>
            <DialogContent className="max-w-6xl h-[95vh] flex flex-col p-6 overflow-hidden bg-slate-50">
                <DialogHeader className="pb-4 border-b">
                    <div className="flex items-center justify-between gap-3 text-2xl">
                        <div className="flex items-center gap-3">
                            <Zap className="h-8 w-8 text-yellow-500 fill-yellow-500" />
                            <div>
                                <span className="font-black text-slate-900 uppercase">Algorithme VRP</span>
                                <div className="text-sm font-medium text-slate-500">
                                    Cible : <span className="text-blue-600 font-bold">{client ? `${client.prenom} ${client.nom}` : "Client Inconnu"}</span>
                                </div>
                            </div>
                        </div>
                        <div className="flex gap-2">
                            <Badge variant="outline" className="bg-white">📍 {client.ville}</Badge>
                            <Badge className={`${ZONE_COLORS[getCommandoDayForDept(client.codePostal?.substring(0, 2) || "75")]}`}>
                                Zone : {getClientCommandoZone(client)?.name || "Hors Zone"}
                            </Badge>
                        </div>
                    </div>
                </DialogHeader>

                <div className="grid grid-cols-12 gap-6 flex-1 overflow-hidden pt-4">
                    {/* LISTE SUGGESTIONS */}
                    <div className="col-span-12 lg:col-span-7 grid grid-cols-2 gap-4 overflow-hidden">
                        <div className="flex flex-col gap-3 overflow-y-auto pr-2">
                            {suggestions.slice(0, 12).map((s) => {
                                const isBlocked = s.status === 'IMPOSSIBLE' && s.reason.includes('Installation');
                                return (
                                    <button
                                        key={s.date.toISOString()}
                                        onClick={() => handleDateSelect(s.date)}
                                        disabled={isBlocked}
                                        className={`p-4 rounded-2xl border-2 text-left transition-all flex justify-between items-center ${isBlocked
                                            ? 'border-red-200 bg-red-50 opacity-60 cursor-not-allowed'
                                            : selectedDate && isSameDay(selectedDate, s.date)
                                                ? 'border-blue-600 bg-white shadow-xl scale-[1.02]'
                                                : 'border-white bg-white hover:border-blue-100 hover:shadow-lg'
                                            }`}
                                    >
                                        <div>
                                            <div className={`font-black capitalize ${isBlocked ? 'text-red-400 line-through' : 'text-slate-700'}`}>
                                                {s.label}
                                            </div>
                                            <div className={`text-xs font-bold uppercase ${isBlocked ? 'text-red-500' : 'text-slate-400'}`}>
                                                {s.region} {s.reason}
                                            </div>
                                        </div>
                                        <Badge className={`${isBlocked
                                            ? 'bg-red-500 text-white'
                                            : s.status === 'OPTIMAL'
                                                ? 'bg-green-500'
                                                : s.status === 'GOOD'
                                                    ? 'bg-blue-500'
                                                    : 'bg-slate-400'
                                            }`}>
                                            {isBlocked ? 'INDISPONIBLE' : s.status}
                                        </Badge>
                                    </button>
                                );
                            })}
                        </div>
                        <div className="bg-white p-4 rounded-3xl shadow-sm border h-fit">
                            <Calendar
                                mode="single"
                                selected={selectedDate}
                                onSelect={handleDateSelect}
                                locale={fr}
                                className="w-full flex justify-center"
                                disabled={(date) => {
                                    // 1. Bloquer weekends (Règle de base)
                                    if (date.getDay() === 0 || date.getDay() === 6) return true;

                                    // 2. Bloquer si la date est déjà occupée par un autre chantier (STRICT)
                                    // Utilisation de la logique "blocked" existante
                                    const dateStr = format(date, 'yyyy-MM-dd');

                                    // Si la date est spécifiquement bloquée
                                    if (blockedDates.has(dateStr)) return true;

                                    // 3. Bloquer si le NOUVEAU chantier ne tient pas (conflit futur)
                                    if (client?.nb_led) {
                                        const end = calculateEstimatedEnd(date, client.nb_led);
                                        let curr = new Date(date);
                                        let checks = 0;
                                        // On vérifie le CHEVAUCHEMENT
                                        // Si je commence le chantier 'date', est-ce que je tombe sur un jour bloqué avant la fin ?
                                        while (curr <= end && checks < 60) {
                                            const currStr = format(curr, 'yyyy-MM-dd');
                                            if (blockedDates.has(currStr)) return true; // Conflit trouvé !

                                            // Avancer (saut week-end géré par calculateEstimatedEnd mais ici on itère simple)
                                            // Attention: calculateEstimatedEnd saute les weekends, donc l'intervalle [start, end] est la durée RÉELLE.
                                            // Notre boucle simple ici check toutes les dates calendaires entre start et end.
                                            // C'est correct car si un chantier bloque un Mardi, et que mon chantier va du Lundi au Mercredi, je suis bloqué.

                                            curr.setDate(curr.getDate() + 1);
                                            checks++;
                                        }
                                    }

                                    return false;
                                }}
                                modifiers={{
                                    zone: (date) => calendarZoneMap[format(date, 'yyyy-MM-dd')] > 0,
                                    blocked: (date) => {
                                        const startStr = format(date, 'yyyy-MM-dd');
                                        // 1. Si la date elle-même est prise
                                        if (blockedDates.has(startStr)) return true;

                                        // 2. Si le chantier commençant ici mordrait sur une date prise
                                        if (client?.nb_led) {
                                            const end = calculateEstimatedEnd(date, client.nb_led);
                                            let curr = new Date(date);
                                            // On vérifie tous les jours de l'intervalle [start, end]
                                            // (start est déjà vérifié ci-dessus, mais on le revérifie dans la boucle c'est pas grave)
                                            let checks = 0;
                                            while (curr <= end && checks < 60) {
                                                const currStr = format(curr, 'yyyy-MM-dd');
                                                if (blockedDates.has(currStr)) return true;

                                                curr.setDate(curr.getDate() + 1);
                                                checks++;
                                            }
                                        }
                                        return false;
                                    },
                                    weekend: (date) => date.getDay() === 0 || date.getDay() === 6
                                }}
                                modifiersClassNames={{
                                    zone: "bg-blue-50 text-blue-600 font-bold border-blue-100 rounded-lg",
                                    blocked: "bg-red-100 text-red-400 line-through opacity-40 cursor-not-allowed pointer-events-none",
                                    weekend: "bg-slate-50 text-slate-200 opacity-25 pointer-events-none"
                                }}
                            />
                        </div>
                    </div>

                    {/* VRP OUTPUT */}
                    <div className="col-span-12 lg:col-span-5 flex flex-col gap-4 bg-white rounded-3xl border shadow-2xl p-6 overflow-hidden">
                        <div className="flex items-center justify-between border-b pb-4">
                            <h2 className="text-xl font-black text-slate-900">VRP OUTPUT</h2>
                            <div className="text-right">
                                <p className="text-[10px] font-bold text-slate-400 uppercase">Distance Totale</p>
                                <p className="text-lg font-black text-blue-600">{totalStats.distance} km</p>
                            </div>
                        </div>

                        <div className="flex-1 overflow-y-auto space-y-6 pr-2">
                            <div className="bg-slate-900 rounded-2xl p-5 text-white relative shadow-lg overflow-hidden">
                                <BarChart3 className="absolute right-[-10px] top-[-10px] w-24 h-24 opacity-5" />
                                <h3 className="font-black text-xs uppercase text-blue-400 mb-3 tracking-widest">## RÉSUMÉ GLOBAL</h3>
                                <div className="text-sm space-y-1 font-bold">
                                    <div className="flex justify-between"><span>Jours nécessaires :</span> <span>{optimizedDays.length}</span></div>
                                    <div className="flex justify-between"><span>Kilométrage :</span> <span>{totalStats.distance} km</span></div>
                                </div>
                            </div>

                            <div className="space-y-6">
                                <h3 className="font-black text-xs uppercase text-slate-400 tracking-widest">## DÉTAIL JOUR PAR JOUR</h3>
                                {optimizedDays.map((day, idx) => (
                                    <div key={idx} className="relative pl-6 border-l-2 border-blue-500">
                                        <div className="font-black text-sm uppercase mb-3">
                                            ### {format(day.date, 'dd/MM/yyyy')} - JOUR {idx + 1}
                                        </div>
                                        <div className="space-y-2">
                                            <div className="text-[10px] font-bold text-slate-400 italic">Départ : 08:00 ({getDepotForClient(client).id.replace('DEPOT_', '')})</div>
                                            {day.stops.map((stop: any, sIdx: number) => (
                                                <div key={sIdx} className={`p-2 rounded-xl text-xs flex items-center justify-between ${stop.id === client.id ? 'bg-blue-600 text-white shadow-lg' : 'bg-slate-50'}`}>
                                                    <div className="font-bold flex items-center gap-2">
                                                        <span className="opacity-60">{stop.arrival}</span>
                                                        <span className="truncate w-32 uppercase">{stop.prenom} {stop.nom}</span>
                                                    </div>
                                                    <span className="text-[9px] opacity-60">{stop.travelTime}m trajet</span>
                                                </div>
                                            ))}
                                            <div className="text-[10px] font-black text-red-500 pt-2 uppercase">🛑 Fin : {day.stops[day.stops.length - 1].ville}</div>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>

                        <div className="pt-4 border-t flex gap-3">
                            <Button variant="outline" className="flex-1 rounded-2xl font-black uppercase" onClick={onClose}>Annuler</Button>
                            <Button
                                className="flex-[2] rounded-2xl font-black uppercase bg-blue-600 shadow-xl gap-2"
                                onClick={handleQuickConfirm}
                                disabled={confirming}
                            >
                                {confirming ? <Loader2 className="animate-spin" /> : <><CheckCircle2 className="h-5 w-5" /> Confirmer</>}
                            </Button>
                        </div>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}
