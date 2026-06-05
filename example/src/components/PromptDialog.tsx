import React from 'react';
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {colors} from '../theme';

type Props = {
  visible: boolean;
  title: string;
  placeholder?: string;
  initialValue?: string;
  onSubmit: (value: string) => void;
  onClose: () => void;
};

/** A minimal single-line text-input dialog (OK / Cancel). */
export function PromptDialog({
  visible,
  title,
  placeholder,
  initialValue = '',
  onSubmit,
  onClose,
}: Props) {
  const [value, setValue] = React.useState(initialValue);
  React.useEffect(() => {
    if (visible) {
      setValue(initialValue);
    }
  }, [visible, initialValue]);

  const submit = () => {
    onSubmit(value.trim());
    onClose();
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.card} onPress={() => {}}>
          <Text style={styles.title}>{title}</Text>
          <TextInput
            style={styles.input}
            value={value}
            onChangeText={setValue}
            placeholder={placeholder}
            placeholderTextColor={colors.textSecondary}
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus
            onSubmitEditing={submit}
          />
          <View style={styles.footer}>
            <Pressable style={styles.footerBtn} onPress={onClose}>
              <Text style={styles.footerText}>CANCEL</Text>
            </Pressable>
            <Pressable style={styles.footerBtn} onPress={submit}>
              <Text style={styles.footerText}>OK</Text>
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
  input: {
    marginHorizontal: 20,
    borderBottomWidth: 1,
    borderBottomColor: colors.primary,
    color: colors.text,
    fontSize: 16,
    paddingVertical: 6,
  },
  footer: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    paddingHorizontal: 12,
    paddingTop: 12,
  },
  footerBtn: {paddingVertical: 8, paddingHorizontal: 12},
  footerText: {color: colors.primary, fontWeight: '600', fontSize: 14},
});
