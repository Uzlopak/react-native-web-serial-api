import {
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {colors} from '../theme';

export type Choice<T> = {label: string; value: T};

type Props<T> = {
  visible: boolean;
  title: string;
  options: Choice<T>[];
  selected: T;
  onSelect: (value: T) => void;
  onClose: () => void;
  /** When set, shows an "Info" button that pops this message. */
  infoMessage?: string;
};

/** Single-choice (radio) dialog, mirroring AlertDialog.setSingleChoiceItems. */
export function SingleChoiceDialog<T extends string | number>({
  visible,
  title,
  options,
  selected,
  onSelect,
  onClose,
  infoMessage,
}: Props<T>) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable testID="choice-card" style={styles.card} onPress={() => {}}>
          <Text style={styles.title}>{title}</Text>
          <ScrollView style={styles.list}>
            {options.map(opt => {
              const isSelected = opt.value === selected;
              return (
                <Pressable
                  key={String(opt.value)}
                  style={styles.row}
                  onPress={() => {
                    onSelect(opt.value);
                    onClose();
                  }}>
                  <Text style={styles.radio}>{isSelected ? '◉' : '◯'}</Text>
                  <Text style={styles.label}>{opt.label}</Text>
                </Pressable>
              );
            })}
          </ScrollView>
          <View style={styles.footer}>
            {infoMessage ? (
              <Pressable
                style={styles.footerBtn}
                onPress={() => Alert.alert(title, infoMessage)}>
                <Text style={styles.footerText}>INFO</Text>
              </Pressable>
            ) : null}
            <Pressable style={styles.footerBtn} onPress={onClose}>
              <Text style={styles.footerText}>CANCEL</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  card: {
    width: '100%',
    maxWidth: 360,
    maxHeight: '80%',
    backgroundColor: colors.background,
    borderRadius: 6,
    paddingVertical: 16,
    elevation: 12,
  },
  title: {
    fontSize: 18,
    fontWeight: '600',
    color: colors.text,
    paddingHorizontal: 20,
    paddingBottom: 12,
  },
  list: {flexGrow: 0},
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 20,
  },
  radio: {fontSize: 18, color: colors.primary, marginRight: 16},
  label: {fontSize: 16, color: colors.text},
  footer: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    paddingHorizontal: 12,
    paddingTop: 8,
  },
  footerBtn: {paddingVertical: 8, paddingHorizontal: 12},
  footerText: {color: colors.primary, fontWeight: '600', fontSize: 14},
});
